# 🛡️ 合同哨兵 ContractGuard

> 面向没有法务的小团队的 **AI 合同风险审查助手**：上传合同 PDF → 1 分钟内按 10 类清单标出风险条款（可点回原文）→ 流式追问 → 一键导出报告。

| 文档 | 说明 |
|---|---|
| [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md) | 产品规划：用户、问题、范围、关键决策、指标、路线图 |
| [docs/SPEC.md](docs/SPEC.md) | 技术规格与验收清单（实现的唯一事实来源） |
| [AGENTS.md](AGENTS.md) | AI 编码 Agent 工作手册 |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | 3 分钟演示脚本 + 面试问答 |
| [docs/EVAL_REPORT.md](docs/EVAL_REPORT.md) | 真实模型评测结果 |

## 快速开始

```bash
npm install
cp .env.example .env      # 填写 LLM_API_KEY（必填，本项目无演示模式）
npm start                 # http://localhost:3000
```

打开首页 → 点击「使用示例合同体验」，约 60–70 秒后看到完整报告。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 启动服务 |
| `npm test` | 单元 + API 冒烟测试（14 项，不消耗模型额度） |
| `npm run eval -- 3` | **真实模型评测**：示例合同跑 3 次，算预埋风险召回率、引用可定位率 + 对等合同反向误报测试 |
| `npm run e2e` | **真实模型前端端到端**（jsdom）：上传 → 审查 → 联动 → 筛选 → 复制 → 追问 → 停止 → 导出 → 埋点（需先 `npm start`） |
| `npm run sample:pdf` | 由 `samples/sample-contract.txt` 重新生成示例 PDF（需中文 TrueType 字体，见脚本说明） |
| `GET /api/metrics` | 埋点漏斗：审查数、追问率、导出率、北极星、审查耗时中位数 |

## 架构

```
浏览器（原生 HTML/CSS/JS，无构建、无 CDN）
  │ POST /api/contracts            上传 PDF / 示例
  │ POST /api/contracts/:id/review SSE 进度 + 结构化风险
  │ POST /api/contracts/:id/chat   SSE 流式追问（RAG）
  │ GET  /api/contracts/:id/report 导出 HTML 报告
  ▼
Node + Express
  parser   PDF → 文本（pdfjs，去页码、合并折行）
  clauses  条款级切分（第X条 / 数字编号 / 段落）
  reviewer 全文 + 10 类清单 → LLM JSON → 清洗 → 引用定位校验 → 规则评分
  retriever 条款级 BM25（中文二元分词 + 口语→合同用语查询扩展）
  chat     检索 top-4 条款 → LLM 流式回答，标注引用
  llm      OpenAI 兼容客户端（重试 / 超时 / 取消）
```

**两条核心设计**
1. **审查走全文、追问走 RAG**：审查要求“不漏”，合同全文直接进上下文；追问要求“准、快、可溯源”，按条款检索。
2. **一切结论可溯源**：模型给出的每条 `quote` 都在后端回原文定位（精确 → 标点/空白归一化 → 跨句片段），定位不到的风险会明确标注“未定位”。

## 配置

| 变量 | 默认 |
|---|---|
| `LLM_API_KEY` | 必填 |
| `LLM_BASE_URL` | `https://llm-proxy.forgeax.com/v1` |
| `LLM_MODEL` | `glm/glm-5.3` |
| `LLM_TIMEOUT_MS` | `180000` |
| `MAX_UPLOAD_MB` / `MAX_CHARS` | `10` / `60000` |

## 隐私与合规
- 上传文件仅在内存解析，不写磁盘；会话 1 小时后自动清除
- 日志不记录合同全文与 API Key
- 全局免责声明：AI 审查意见仅供参考，不构成法律意见
