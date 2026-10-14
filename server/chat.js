// 追问：条款级 BM25 检索 top-k → LLM 流式回答（RAG）
import { chatStream } from './llm.js';
import { LEVEL_NAME, CATEGORY_NAME } from './checklist.js';

export const CHAT_SYSTEM_PROMPT = `你是合同审查助手，正在帮【乙方】解读一份合同。用户是不懂法律的商务人员。
规则：
1. 只能依据下面提供的“相关条款”回答；引用时写明条款编号，如「第十一条」。
2. 如果相关条款里没有依据，明确说“合同中未约定”，再给出一般性的实务建议（标明是一般建议）。
3. 先给结论，再解释；用通俗语言；适当分点；总长度控制在 300 字以内。
4. 需要谈判时，给出可以直接发给对方的话术或修改后的条款。
5. 不要在结尾加免责声明（界面已展示）。`;

export function buildRetrievalQuery(question, risk) {
  return risk ? `${question} ${risk.title} ${risk.quote}` : question;
}

export function selectSources(contract, index, question, risk, k = 4) {
  const hits = index.search(buildRetrievalQuery(question, risk), k).map((h) => h.clause);
  if (risk?.clauseId && !hits.some((c) => c.id === risk.clauseId)) {
    const c = contract.clauses.find((x) => x.id === risk.clauseId);
    if (c) { hits.unshift(c); hits.length = Math.min(hits.length, k); }
  }
  return hits;
}

export async function answer({ contract, sources, question, risk, onToken, signal }) {
  const ctx = sources.map((c) => `【${c.no}${c.title ? ' ' + c.title : ''}】\n${c.text.trim()}`).join('\n\n');
  let user = `相关条款：\n${ctx}\n\n`;
  if (risk) {
    user += `用户正在追问这条已识别的风险：\n- 等级：${LEVEL_NAME[risk.level]}；类别：${CATEGORY_NAME[risk.category]}\n- 标题：${risk.title}\n- 原文：${risk.quote}\n- 说明：${risk.explanation}\n- 建议：${risk.suggestion}\n\n`;
  }
  user += `问题：${question}`;
  const history = contract.chatHistory.slice(-6);
  const messages = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...history, { role: 'user', content: user }];
  return chatStream(messages, onToken, { signal });
}
