# AGENTS.md — 合同哨兵 ContractGuard

> 给 AI 编码 Agent 的工作手册。任何 Agent（含子 Agent）开始工作前必须先读本文件，再读 `docs/SPEC.md`。

## 1. 项目是什么
面向无法务中小团队的 **AI 合同风险审查 Web Demo**：上传 PDF → 自动按 10 类清单标出风险条款（原文定位）→ 流式追问（条款级 RAG）→ 导出报告。
用途：**产品经理岗位面试演示**。体验与稳定性 > 工程完备性。

## 2. 文档优先级（冲突时按此顺序）
1. `docs/SPEC.md` —— 实现的唯一事实来源（接口、数据模型、算法、验收清单）
2. `docs/PRODUCT_PLAN.md` —— 产品意图与决策理由（SPEC 未覆盖时据此判断）
3. 本文件 —— 工作方式与约束

SPEC 有歧义时：选择 **更利于现场演示稳定** 的方案，并在 SPEC 对应处补一行 `> 决策：…`，不要停下来等人。

## 3. 运行环境（硬约束）
- 运行在 **Android / Termux（aarch64）** 上的 Node 24，**不可使用需要原生编译或无 android-arm64 预编译包的依赖**（如 sharp、canvas、better-sqlite3、Next.js SWC、puppeteer）。
- 允许的运行时依赖：`express`、`multer`、`pdfjs-dist`（legacy build）、`pdfkit`（仅生成示例 PDF 的脚本，可选）。新增依赖需在 SPEC §9 下记录理由。
- 前端：原生 HTML/CSS/JS，**无构建步骤、无框架、无 CDN 依赖**（面试现场可能离线）。
- 模块：ESM（`"type": "module"`），Node 内置 `fetch`、`node:test`。

## 4. 常用命令
```bash
npm install
npm start            # http://localhost:3000
npm test             # node:test（--test-isolation=none，兼容 Android）
npm run sample:pdf   # 由 samples/sample-contract.txt 生成 sample-contract.pdf
```
配置：复制 `.env.example` 为 `.env` 并填写 `LLM_API_KEY`（必填，**本项目不提供演示/预置模式，一切结果来自真实模型**）。
```bash
npm run eval         # 真实 LLM 审查示例合同，输出召回率/定位率
```

## 5. 工作流程（每个任务）
1. 对照 SPEC 找到对应章节与验收项（§10 的 A1–A11）
2. 实现 → 写/更新 `test/` 中对应测试 → `npm test` 通过
3. 涉及 API 的改动：启动服务后用 `curl` 实测一次（包括 SSE）
4. 涉及 UI 的改动：至少用 `curl` 校验静态资源可访问；JS 语法用 `node --check public/app.js`
5. 在 SPEC §10 勾选完成的验收项；未能验证的标注 `（待验证：原因）`
6. 不要提交 `.env`、`node_modules`、`logs/`

## 6. 代码约定
- 一个文件一个职责，与 SPEC §2 目录一致；单文件尽量 < 300 行
- 用户可见文案一律中文；错误码英文大写下划线、message 中文且可直接展示
- 所有 `innerHTML` 插入必须先 `escapeHtml`
- LLM 提示词集中写在对应模块顶部常量中，便于面试展示
- 不记录合同全文、不记录 API Key；上传文件不写磁盘（multer memoryStorage）
- 失败要优雅：任何 LLM 异常都不能让页面卡死，必须给出中文错误 + 重试入口；**禁止用预置/假数据掩盖失败**

## 7. 质量红线（违反即视为未完成）
- 示例合同用真实模型完整走通：上传 → 审查 → 报告 → 追问 → 导出
- `npm run eval` 召回 ≥ 7/8、引用可定位率 ≥ 90%
- 评分由规则计算，不由模型给出
- 每条风险必须带 `quote`；不可定位的标记 `located:false` 并在 UI 提示

## 8. 产品语感（写文案/做取舍时参考）
- 用户是 **不懂法律的商务人员**：说人话，少用法条术语；建议要能直接复制发给对方
- 先结论后细节：总评分 → 高风险 → 细节
- 可信感来自 **可溯源**：一切结论都能点回原文
- 永远显示免责声明，但不要让它喧宾夺主

## 9. 完成定义
SPEC §10 全部勾选，`npm test` 通过，README 与 `docs/DEMO_SCRIPT.md` 就绪。
