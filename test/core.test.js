import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { splitClauses, findClauseAt } from '../server/clauses.js';
import { tokenize, buildIndex } from '../server/retriever.js';
import { locateQuote } from '../server/locate.js';
import { computeScore } from '../server/checklist.js';
import { sanitizeRisks } from '../server/reviewer.js';
import { parseJSONLoose } from '../server/llm.js';
import { pdfToText, reflow } from '../server/parser.js';

const sample = fs.readFileSync(new URL('../samples/sample-contract.txt', import.meta.url), 'utf8');

test('条款切分：识别 前言 + 第一条…第十五条，偏移可还原原文', () => {
  const cs = splitClauses(sample);
  assert.equal(cs[0].no, '前言');
  assert.equal(cs.length, 16);
  assert.equal(cs[11].no, '第十一条');
  assert.equal(cs[11].title, '合同解除');
  for (const c of cs) assert.equal(sample.slice(c.start, c.end), c.text);
  const at = sample.indexOf('甲方所在地');
  assert.equal(findClauseAt(cs, at).no, '第十四条');
});

test('条款切分：无“第X条”时按数字编号或段落切分', () => {
  const t = '服务协议\n\n1. 服务内容\n乙方提供咨询。\n2. 费用\n每月一万元。\n3. 期限\n一年。';
  assert.deepEqual(splitClauses(t).map((c) => c.no), ['前言', '1.', '2.', '3.']);
  const p = splitClauses('甲乙双方同意合作。\n\n费用按月结算。');
  assert.deepEqual(p.map((c) => c.no), ['段落1', '段落2']);
});

test('分词：中文二元组 + 英文数字', () => {
  const t = tokenize('违约金 1% 合同');
  assert.ok(t.includes('违约') && t.includes('约金') && t.includes('合同') && t.includes('1%'));
});

test('BM25：问题能检索到对应条款', () => {
  const idx = buildIndex(splitClauses(sample));
  assert.equal(idx.search('对方能不能随时解除合同？', 1)[0].clause.no, '第十一条');
  assert.equal(idx.search('打官司去哪个法院', 2).map((h) => h.clause.no).includes('第十四条'), true);
  assert.equal(idx.search('尾款什么时候付', 1)[0].clause.no, '第四条');
  assert.equal(idx.search('知识产权归谁', 1)[0].clause.no, '第七条');
});

test('引用定位：精确、空白/标点差异、跨句拼接、编造', () => {
  const exact = locateQuote(sample, '任何一方均应向甲方所在地有管辖权的人民法院提起诉讼');
  assert.ok(exact && sample.slice(exact.start, exact.end).includes('甲方所在地'));
  const fuzzy = locateQuote(sample, '剩余60%合同款项,由甲方在项目最终验收合格之日起180日内向乙方支付');
  assert.ok(fuzzy);
  assert.ok(sample.slice(fuzzy.start, fuzzy.end).startsWith('剩余 60%'));
  const joined = locateQuote(sample, '甲方可根据自身经营需要随时书面通知乙方解除本合同，甲方无需就乙方已完成的工作支付任何费用');
  assert.ok(joined && sample.slice(joined.start, joined.end).includes('本合同自通知送达乙方之日起解除'));
  assert.equal(locateQuote(sample, '乙方须向甲方支付五百万元保证金且不予退还'), null);
});

test('评分：乘法递减规则，风险多也保留区分度', () => {
  assert.equal(computeScore({ high: 0, medium: 0, low: 0 }), 100);
  assert.equal(computeScore({ high: 1, medium: 0, low: 0 }), 85);
  assert.equal(computeScore({ high: 2, medium: 3, low: 1 }), 57);
  assert.equal(computeScore({ high: 7, medium: 4, low: 0 }), 24);
  assert.ok(computeScore({ high: 30, medium: 0, low: 0 }) >= 0);
});

test('风险清洗：非法等级丢弃、类别兜底、去重、定位与排序', () => {
  const contract = { fullText: sample, clauses: splitClauses(sample) };
  const risks = sanitizeRisks([
    { level: 'medium', category: 'dispute', title: '对方所在地管辖', quote: '向甲方所在地有管辖权的人民法院提起诉讼', explanation: 'e', suggestion: 's' },
    { level: 'high', category: 'xxx', title: '无上限赔偿', quote: '赔偿金额不受合同总金额限制', explanation: 'e', suggestion: 's' },
    { level: 'high', category: 'indemnity', title: '重复', quote: '赔偿金额不受合同总金额限制', explanation: 'e', suggestion: 's' },
    { level: 'critical', category: 'ip', title: '非法等级', quote: '既有技术', explanation: 'e', suggestion: 's' },
    { level: 'low', category: 'other', title: '编造', quote: '这句话在合同里根本不存在哦', explanation: 'e', suggestion: 's' },
  ], contract);
  assert.equal(risks.length, 3);
  assert.deepEqual(risks.map((r) => r.level), ['high', 'medium', 'low']);
  assert.equal(risks[0].category, 'other');
  assert.equal(risks[0].clauseNo, '第十二条');
  assert.equal(risks[2].located, false);
  assert.deepEqual(risks.map((r) => r.id), ['r1', 'r2', 'r3']);
});

test('JSON 容错解析', () => {
  assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONLoose('好的：{"a":2} 完毕'), { a: 2 });
  assert.throws(() => parseJSONLoose('no json'));
});

test('PDF 解析：示例 PDF 可提取全部条款与关键句', async () => {
  const text = await pdfToText(fs.readFileSync(new URL('../samples/sample-contract.pdf', import.meta.url)));
  assert.equal(splitClauses(text).length, 16);
  for (const k of ['验收合格之日起 180 日内向乙方支付', '赔偿金额不受合同总金额限制', '验收标准及验收期限由甲方根据实际情况确定']) assert.ok(text.includes(k), k);
});

test('折行合并：不合并新条款/句末行', () => {
  const out = reflow(['第一条 内容很长很长很长很长很长很长很长很长很长很长很长很长很', '长的句子结束了。', '第二条 下一条', '1']);
  assert.equal(out, '第一条 内容很长很长很长很长很长很长很长很长很长很长很长很长很长的句子结束了。\n第二条 下一条');
});
