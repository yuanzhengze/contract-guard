// 风险审查：全文 + 固定清单 → LLM(JSON) → 校验清洗 → 定位 → 评分
import { chatJSON, parseJSONLoose } from './llm.js';
import { CHECKLIST, CATEGORY_KEYS, LEVELS, computeScore } from './checklist.js';
import { findClauseAt } from './clauses.js';
import { locateQuote, normalizeWithMap } from './locate.js';
import { AppError } from './errors.js';

export const REVIEW_SYSTEM_PROMPT = `你是一位资深商事律师，专门为没有法务团队的中小企业审查合同。
你的委托人是合同中的【乙方】，请始终站在乙方立场，找出对乙方不利或存在隐患的条款。

## 审查清单（必须逐类检查，每类 0–3 条，没有就不写）
${CHECKLIST.map((c, i) => `${i + 1}. ${c.key}（${c.name}）：${c.points}`).join('\n')}

## 风险等级
- high：可能造成重大经济损失或丧失关键权利，签约前必须修改
- medium：明显对乙方不利，建议协商修改
- low：表述不清或可以优化，知悉即可

## 硬性要求
1. quote 必须从合同原文中【逐字复制】一段连续文字（不改字、不加省略号、不拼接），长度 10–150 字，只引用最关键的那句。
2. 只报告合同中真实存在的问题，严禁编造；一个问题只报一次，不要因为同一条款在多个类别重复报告。
3. 语言通俗，面向不懂法律的商务人员。title ≤ 16 字；explanation ≤ 100 字，说清“会给乙方带来什么后果”；suggestion ≤ 120 字，写成可以直接发给对方的修改后条款或谈判话术。
4. summary：≤ 50 字的一句话总评，先说结论。
5. 只输出 JSON，不要任何其他文字。

## 输出 JSON 结构
{
  "contractType": "合同类型，如 软件开发服务合同",
  "parties": { "us": "乙方名称", "them": "甲方名称" },
  "summary": "一句话总评",
  "risks": [
    { "level": "high|medium|low", "category": "清单 key", "title": "...", "quote": "原文逐字片段", "explanation": "...", "suggestion": "..." }
  ]
}`;

function buildUserPrompt(contract) {
  const body = contract.clauses.map((c) => `【${c.no}】\n${c.text.trim()}`).join('\n\n');
  return `以下是待审查的合同全文（共 ${contract.clauses.length} 个条款，【】内为条款编号，仅供定位，不属于原文，quote 中不要包含）：\n\n${body}`;
}

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

export function sanitizeRisks(rawRisks, contract) {
  const normCache = normalizeWithMap(contract.fullText);
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rawRisks) ? rawRisks : []) {
    if (!r || typeof r !== 'object') continue;
    const level = String(r.level || '').toLowerCase();
    if (!LEVELS.includes(level)) continue;
    const category = CATEGORY_KEYS.includes(r.category) ? r.category : 'other';
    const quote = clip(r.quote, 300);
    const title = clip(r.title, 30);
    if (!quote || !title) continue;
    const loc = locateQuote(contract.fullText, quote, normCache);
    const key = loc ? `${loc.start}-${loc.end}` : quote;
    if (seen.has(key)) continue;
    // 与已有风险定位区间高度重叠的视为重复
    if (loc && out.some((o) => o.located && Math.min(o.end, loc.end) - Math.max(o.start, loc.start) > 0.6 * Math.min(o.end - o.start, loc.end - loc.start))) continue;
    seen.add(key);
    const clause = loc ? findClauseAt(contract.clauses, loc.start) : null;
    out.push({
      level, category, title, quote: loc ? contract.fullText.slice(loc.start, loc.end) : quote,
      clauseId: clause?.id || null, clauseNo: clause?.no || null,
      located: !!loc, start: loc?.start ?? null, end: loc?.end ?? null,
      explanation: clip(r.explanation, 240), suggestion: clip(r.suggestion, 300),
    });
    if (out.length >= 20) break;
  }
  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level] || (a.start ?? 1e9) - (b.start ?? 1e9));
  out.forEach((r, i) => { r.id = 'r' + (i + 1); });
  return out;
}

// onProgress({ phase: 'thinking'|'writing'|'retry', risksFound, retry })：把模型真实进展透传给前端
export async function reviewContract(contract, { signal, onProgress } = {}) {
  const t0 = Date.now();
  const messages = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(contract) },
  ];
  let parsed;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const { content } = await chatJSON(attempt ? [...messages, { role: 'user', content: '上一次输出不是合法 JSON。请只输出符合结构的 JSON。' }] : messages, {
      signal,
      onRetry: (n) => onProgress?.({ phase: 'retry', retry: n }),
      onProgress: (st) => onProgress?.(st.content ? { phase: 'writing', risksFound: (st.text.match(/"level"/g) || []).length } : { phase: 'thinking' }),
    });
    try { parsed = parseJSONLoose(content); } catch { console.error('[review] JSON 解析失败，attempt', attempt, content.slice(0, 200)); }
  }
  if (!parsed) throw new AppError('LLM_BAD_OUTPUT', 'AI 返回格式异常，请重试', 502);

  const risks = sanitizeRisks(parsed.risks, contract);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of risks) counts[r.level]++;
  return {
    score: computeScore(counts),
    counts,
    summary: clip(parsed.summary, 120) || (risks.length ? `发现 ${risks.length} 处需要关注的条款` : '未发现明显风险条款'),
    contractType: clip(parsed.contractType, 40) || '合同',
    parties: { us: clip(parsed.parties?.us, 60) || '乙方', them: clip(parsed.parties?.them, 60) || '甲方' },
    risks,
    locatedRate: risks.length ? risks.filter((r) => r.located).length / risks.length : 1,
    durationMs: Date.now() - t0,
  };
}
