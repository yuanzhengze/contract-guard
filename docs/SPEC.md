# SPEC：合同哨兵 ContractGuard v0.1

> 本文件是实现的唯一事实来源（Single Source of Truth）。产品背景见 `PRODUCT_PLAN.md`，Agent 工作规则见 `../AGENTS.md`。
> 状态标记：每个验收项完成后在 §10 打勾。

---

## 1. 系统概览

```
浏览器（原生 HTML/CSS/JS，无构建）
  │  POST /api/contracts            上传 PDF / 使用示例
  │  POST /api/contracts/:id/review SSE：审查进度 + 结果
  │  POST /api/contracts/:id/chat   SSE：流式追问
  │  GET  /api/contracts/:id/report 导出 HTML 报告
  ▼
Node.js 20+ / Express（单进程）
  ├─ parser      PDF → 纯文本（pdfjs-dist legacy build）
  ├─ clauses     文本 → 条款数组（按“第X条”/编号切分）
  ├─ reviewer    全文 + 清单 → LLM(JSON) → 校验 → 风险数组 + 评分
  ├─ retriever   条款级 BM25（中文二元分词 + 英文词）
  ├─ chat        检索 top-k 条款 → LLM 流式 → SSE
  ├─ llm         OpenAI 兼容客户端（fetch + SSE 解析），默认 glm/glm-5.3
  ├─ store       内存 Map，会话 TTL 1 小时（不落盘）
  └─ metrics     埋点 → logs/events.jsonl + GET /api/metrics
```

## 2. 目录结构

```
contract-review/
├─ AGENTS.md
├─ README.md
├─ package.json
├─ .env.example
├─ docs/  PRODUCT_PLAN.md  SPEC.md  DEMO_SCRIPT.md  EVAL_REPORT.md
├─ server/
│  ├─ index.js          启动入口
│  ├─ app.js            Express 应用与路由（可注入依赖，便于测试）
│  ├─ locate.js         引用定位（防幻觉）
│  ├─ errors.js
│  ├─ config.js         读取环境变量
│  ├─ parser.js
│  ├─ clauses.js
│  ├─ checklist.js      10 类风险清单（与 PRODUCT_PLAN §6 一致）
│  ├─ reviewer.js
│  ├─ retriever.js
│  ├─ chat.js
│  ├─ llm.js
│  ├─ report.js         HTML 报告渲染
│  ├─ store.js
│  └─ metrics.js
├─ public/  index.html  app.js  styles.css
├─ samples/
│  ├─ sample-contract.txt        示例合同原文（8 处预埋风险）
│  ├─ sample-contract.pdf        由脚本生成
│  ├─ fair-contract.txt/.pdf     条款对等的合同（反向测试误报）
│  └─ expected-risks.json        预埋风险答案（仅用于评测召回率，不参与运行）
├─ scripts/ make-sample-pdf.js  eval.js（真实模型评测）  ui-e2e.js（jsdom 前端走查）
└─ test/    *.test.js             node:test
```

## 3. 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | |
| `LLM_API_KEY` | 必填 | 缺失时服务启动报错退出（不提供演示模式） |
| `LLM_BASE_URL` | `https://llm-proxy.forgeax.com/v1` | OpenAI 兼容 |
| `LLM_MODEL` | `glm/glm-5.3` | |
| `LLM_TIMEOUT_MS` | `180000` | |
| `MAX_UPLOAD_MB` | `10` | |
| `MAX_CHARS` | `60000` | 超出拒绝 |

## 4. 数据模型

```ts
type Clause = {
  id: string;        // "c1", "c2" ...
  no: string;        // 显示编号，如 "第五条" / "5.2"；无编号时为 "段落N"
  title: string;     // 条款标题（若有），否则取首 20 字
  text: string;      // 条款全文
  start: number;     // 在全文 fullText 中的字符偏移
  end: number;
};

type Risk = {
  id: string;            // "r1" ...
  level: "high" | "medium" | "low";
  category: CategoryKey; // checklist key，见 PRODUCT_PLAN §6
  title: string;         // ≤ 20 字，如 "对方可任意单方解除"
  quote: string;         // 原文逐字引用（≤ 200 字）
  clauseId: string|null; // 定位到的条款
  located: boolean;      // quote 是否能在原文中定位
  start: number|null;    // quote 在 fullText 中的偏移（located 时）
  end: number|null;
  explanation: string;   // 为什么是风险（面向非法务，≤ 120 字）
  suggestion: string;    // 建议修改为……（可直接复制给对方，≤ 150 字）
};

type Review = {
  score: number;                 // 规则计算，见 §6.2
  counts: { high: number; medium: number; low: number };
  summary: string;               // 一句话总评 ≤ 60 字
  contractType: string;          // 如 "软件开发服务合同"
  parties: { us: string; them: string }; // us = 乙方（审查立场），见 §6.2
  risks: Risk[];                 // 按 level(high→low) 再按 start 排序
  durationMs: number;
};

type Contract = {
  id: string;            // nanoid/crypto.randomUUID 截 8 位
  fileName: string;
  fullText: string;
  clauses: Clause[];
  review: Review | null;
  isSample: boolean;
  createdAt: number;
  chatHistory: { role: "user"|"assistant"; content: string }[]; // 最多保留最近 10 条
};
```

## 5. API

所有错误响应：`{ "error": { "code": string, "message": string(中文，可直接展示) } }`

### 5.1 `POST /api/contracts`
- `multipart/form-data`，字段 `file`（PDF）；或 JSON `{ "sample": true }`
- 校验：类型必须 PDF（扩展名或 mime）→ `INVALID_TYPE`；超过上限 → `FILE_TOO_LARGE`；提取文字 < 100 字 → `SCANNED_PDF`（“暂不支持扫描件，请上传文字版 PDF”）；> MAX_CHARS → `TOO_LONG`
- 200：`{ id, fileName, charCount, clauses: Clause[], fullText, isSample }`

### 5.2 `POST /api/contracts/:id/review` （SSE）
`Content-Type: text/event-stream`，事件：
| event | data | 说明 |
|---|---|---|
| `progress` | `{ step, label, percent }` | step ∈ parse/split/analyze/verify/done |
| `result` | `Review` | 完成 |
| `error` | `{ code, message }` | 失败 |

- 已有结果直接推送 `result`（幂等）
- LLM 调用期间每 2.5 秒推送一次 analyze 进度：模型思考阶段 label 轮播清单类别（“正在检查付款条款…”）；模型开始输出后显示真实计数（“已发现 N 处风险，正在整理报告…”）；重试时显示“正在自动重试”
- **全部走真实 LLM，无演示/预置结果**。LLM 失败 → `error` 事件（code `LLM_ERROR`），前端提供「重试」按钮

### 5.3 `POST /api/contracts/:id/chat` （SSE）
- 请求 JSON：`{ question: string(1–500), riskId?: string }`
- 事件：`sources` → `{ clauses: [{id,no,title,snippet}] }`（先发）；`token` → `{ t }`（多次）；`done` → `{ text }`；`error`
- 检索：query = question（+ riskId 对应风险的 title/quote）→ BM25 top-4 条款；若 riskId 对应条款不在结果中则强制置顶
- 全部为真实 LLM 流式输出

### 5.4 `GET /api/contracts/:id/report`
- 返回独立 HTML（内联 CSS，`@media print` 友好），`Content-Disposition: attachment; filename="合同审查报告-<文件名>.html"`（filename* 用 UTF-8 编码）
- 内容：标题、文件名、审查时间、评分与计数、总评、风险明细表（等级/类别/条款号/原文/说明/建议）、免责声明
- 未审查 → 409 `NOT_REVIEWED`

### 5.5 `POST /api/events` / `GET /api/metrics`
- 前端埋点 `{ name, contractId?, props? }`，name ∈ `page_view, upload, sample_used, review_done, chat_sent, risk_ask_clicked, export`
- 服务端追加写入 `logs/events.jsonl`；`/api/metrics` 返回各事件计数 + 追问率、导出率

### 5.6 `GET /api/health` → `{ ok: true, model }`

## 6. 核心算法

### 6.1 条款切分（clauses.js）
1. 统一换行、去除 PDF 页眉页脚中纯页码行（`/^\s*-?\s*\d+\s*-?\s*$/`、`第\s*\d+\s*页`）
2. 识别条款起始行正则（行首）：`第[一二三四五六七八九十百零〇\d]+条`，以及 `^\d{1,2}[\.、]\s*\S`（一级编号）
3. 相邻两个起始行之间为一个条款；首个起始行之前的内容为 “前言”（合同名、双方信息）
4. 未识别到任何编号 → 按空行分段，每段为 “段落N”；单段 > 1500 字时按句号再切
5. 保证所有 clause 的 `start/end` 能还原 `fullText` 中对应位置

### 6.2 风险审查（reviewer.js）
- 立场：v0.1 固定 **站在乙方立场** 审查（示例合同中乙方 = 用户方）。模型需识别并返回双方名称，报告顶部显示“审查立场：乙方（xxx）”。路线图：让用户上传时选择立场。
- 系统提示要点（中文）：
  - 角色：为没有法务背景的中小企业审查合同的资深商事律师
  - 必须逐项检查 10 类清单（附清单要点），每类 0–3 条风险，不得编造合同中没有的内容
  - `quote` 必须逐字复制原文连续片段（不改字、不加省略号），≤ 200 字
  - 语言通俗，`suggestion` 写成可直接发给对方的修改条款
  - 仅输出 JSON：`{ contractType, parties:{us,them}, summary, risks:[{level,category,title,quote,explanation,suggestion}] }`
- 调用：`temperature 0.1`，`response_format: {type:"json_object"}`；输入为带条款号的全文
- 解析容错：剥离 ```json 包裹；JSON.parse 失败则重试 1 次（附“只输出合法 JSON”）
- 校验与清洗：
  - level/category 非法 → 丢弃该条（category 非法则归 `other`）
  - 引用定位：先精确 `indexOf`；失败则归一化（去空白、统一中英文标点）后匹配并映射回原始偏移；再失败则按标点拆段分别定位，覆盖率 ≥60% 且区间紧凑时取覆盖区间（展示原文而非模型文本）；仍失败 → `located:false`
    > 决策：实测模型会拼接同一条款中不相邻的两句，加入分段定位
  - 按 quote 去重；最多 20 条
  - 根据 start 找到所属 clauseId
- 评分：`score = round(100 × 0.85^high × 0.93^medium × 0.98^low)`
  > 决策：线性扣分在实测中把示例合同（7 高 4 中）打成 0 分，失去区分度，改为乘法递减（见 PRODUCT_PLAN §6）

### 6.3 检索（retriever.js）
- 分词：英文/数字按 `\w+` 小写；中文连续串生成 **二元组(bigram)**，单字串保留单字；去除常见停用字（的、了、和、与、或、及、在、为）
- 查询扩展：口语 → 合同用语同义词表（尾款→剩余款项/支付，打官司→诉讼/管辖…）
  > 决策：实测“尾款什么时候付”零命中（合同写“剩余 60% 合同款项”），加入扩展表
- BM25：k1=1.5, b=0.75；文档 = 条款（title + text）
- 返回 top-k 及分数；全部为 0 分时返回前言 + 前 3 条

### 6.4 追问（chat.js）
- 系统提示：只能基于提供的条款回答；引用时用「第X条」格式；条款中找不到依据时明确说“合同中未约定”，并给出一般性建议；结尾不重复免责声明（UI 已有）
- 上下文：检索条款（带编号）+ 若有 riskId 附风险卡片 + 最近 6 轮对话
- `temperature 0.3`, `stream: true`

### 6.5 LLM 客户端（llm.js）
- `chatJSON(messages, opts)` 与 `chatStream(messages, onToken, opts)`，基于全局 `fetch`
- SSE 解析：按行读取 `data: `，`[DONE]` 结束；兼容 `delta.content`
- 超时 AbortController；HTTP 非 2xx 抛出带状态码错误（401 → message “API Key 无效”）

## 7. 前端（public/）

### 7.1 页面状态机
`landing → uploading → reviewing → report`（任意状态出错 → 错误提示条，可返回 landing）

### 7.2 Landing
- 产品名 + 一句话定位 + 三个卖点（1 分钟出报告 / 每条风险可定位原文 / 给出可直接用的修改建议）
- 大号拖拽上传区（点击亦可），说明“支持文字版 PDF，≤10MB，文件不会被保存”
- 次要按钮「没有合同？使用示例合同体验」
- 顶部右侧显示模型徽标：`AI 引擎：GLM-5.3`

### 7.3 Reviewing
- 居中进度卡：步骤列表（解析文档 → 识别条款 → AI 逐项审查 → 校验引用 → 生成报告），当前步骤动效，进度条，轮播文案

### 7.4 Report（桌面 ≥ 1024px 双栏；窄屏上下堆叠）
- **顶栏**：文件名、合同类型、审查立场；按钮「导出报告」「重新上传」
- **总览条**：环形安全评分（≥80 绿，60–79 橙，<60 红）+ 高/中/低计数（可点击筛选）+ 总评
- **左栏 · 合同原文**：按条款渲染；风险 quote 用 `<mark class="risk-high|medium|low" data-risk="rX">` 高亮；点击高亮 → 右侧对应卡片滚动并闪烁
- **右栏 · 两个 Tab**：
  - 「风险清单」：按等级排序的卡片（等级徽标、类别、标题、条款号、原文引用折叠、说明、建议 + 「复制建议」「追问这条」）；未定位的卡片显示“⚠ 未能在原文中定位”；点击卡片 → 左侧滚动到高亮并闪烁
  - 「AI 追问」：消息列表 + 输入框 + 3 个快捷问题（“这份合同最需要先改哪一条？”“如果对方违约我能获得什么赔偿？”“合同能否提前解除？要付出什么代价？”）；助手消息流式显示，下方显示“参考条款”chips，点击定位原文；生成中可「停止」（AbortController）
- **底部固定免责声明**：“本工具由 AI 生成审查意见，仅供参考，不构成法律意见。重要合同请咨询专业律师。”

### 7.5 实现约束
- 不引入前端框架/构建；SSE 用 `fetch` + `ReadableStream` 手动解析（因为是 POST）
- 所有插入 DOM 的文本必须转义（防 XSS）；Markdown 仅支持 `**粗体**` 与换行
- 视觉：白底、主色 #2563EB；高 #DC2626 / 中 #EA580C / 低 #16A34A；系统中文字体栈

## 8. 示例合同（samples/sample-contract.txt）
《软件开发服务合同》，甲方：星河零售有限公司（委托方），乙方：用户方（开发公司“青禾科技有限公司”），约 15 条、2500–4000 字。预埋 8 处风险（审查立场为乙方）：

| # | 风险 | 等级 | 类别 |
|---|---|---|---|
| 1 | 验收合格后 **180 天** 内付款，且尾款比例 60% | 高 | payment |
| 2 | 乙方逾期交付每日违约金为合同总额 **1%**，甲方逾期付款无任何责任 | 高 | liability |
| 3 | 甲方可 **随时无理由** 解除合同且无需支付已完成部分费用 | 高 | termination |
| 4 | 乙方对甲方一切损失（含间接损失、利润损失）承担 **无上限** 赔偿 | 高 | indemnity |
| 5 | 乙方 **既有技术与通用组件** 的知识产权一并归甲方所有 | 中 | ip |
| 6 | 甲方 **单方** 有权变更需求，乙方不得因此调整费用与工期 | 中 | other |
| 7 | 争议提交 **甲方所在地** 人民法院管辖 | 中 | dispute |
| 8 | 甲方收到交付物后 **未明确** 验收标准，验收期限由甲方决定 | 中 | acceptance |

`expected-risks.json`：上表 8 条的关键词，`npm run eval` 用真实 LLM 审查示例合同并计算召回率与引用可定位率。

## 9. 非功能要求
> 依赖记录：运行时 `express` `multer` `pdfjs-dist`；工具 `pdfkit`（生成示例 PDF）、`jsdom`（devDependency，前端端到端测试，因设备无可用浏览器自动化）。
> 决策：Android 上 `node --test` 子进程隔离不可用，测试使用 `--test-isolation=none`。
> 决策：LLM 客户端统一走 SSE 流式（JSON 模式也是），以 **空闲超时 `LLM_IDLE_MS`=45s** 判定卡死；对网络/限流/5xx/超时/卡死做 2 次指数退避重试；追问一旦已输出 token 不再重试（实测代理偶发 fetch failed 与长时间无响应）。
> 决策：审查任务与 HTTP 连接解耦，刷新/断线不中断、不重复计费；进度文案透传模型真实进展（思考中 / 已发现 N 处风险 / 自动重试中）。
- 启动：`npm install && npm start`，无原生编译依赖（需在 Android/Termux aarch64 上可运行）
- 隐私：上传文件只在内存解析，不写磁盘；会话 1 小时 TTL，每 10 分钟清理
- 日志中不得记录合同全文与 API Key
- 示例合同真实审查端到端 < 90 秒

## 10. 验收清单（Definition of Done）
- [x] A1 `npm start` 启动，`/api/health` 返回模型
- [x] A2 示例合同 → 进度 → 报告（真实 LLM），风险卡片可定位原文
- [x] A3 卡片 ↔ 原文双向定位与闪烁
- [x] A4 等级筛选、复制建议可用
- [x] A5 追问：流式输出、参考条款 chips 可定位、可停止；“追问这条”带入上下文
- [x] A6 导出报告可下载，打开排版正确，含免责声明
- [x] A7 上传非 PDF / 超大 / 扫描件 / LLM 失败 → 中文友好报错，可重试
- [x] A8 `npm run eval`：真实 LLM 召回 ≥ 7/8，引用可定位率 ≥ 90%（实测 3 次均 8/8、100%；反向测试 91 分无误报，见 EVAL_REPORT）
- [x] A9 埋点写入，`/api/metrics` 返回计数与比率
- [x] A10 `npm test` 全部通过（14 项：切分、BM25、引用定位、评分、清洗、PDF 解析、API 冒烟）；`npm run e2e` 真实模型前端走查 20 项通过
- [x] A11 README（启动、配置、演示步骤）+ DEMO_SCRIPT（3 分钟演示稿 + 面试问答）
