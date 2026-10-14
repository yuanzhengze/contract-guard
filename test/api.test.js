// API 冒烟：用替身注入 review/answer，不消耗模型额度；真实模型效果由 npm run eval 验证
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../server/app.js';

let server, base;
const fakeReview = async (c) => ({
  score: 85, counts: { high: 1, medium: 0, low: 0 }, summary: '测试', contractType: '测试合同', parties: { us: '乙', them: '甲' },
  risks: [{ id: 'r1', level: 'high', category: 'dispute', title: '管辖', quote: '甲方所在地', clauseId: c.clauses[14].id, clauseNo: '第十四条', located: true, start: 0, end: 1, explanation: 'e', suggestion: 's' }],
  locatedRate: 1, durationMs: 5,
});
const fakeAnswer = async ({ onToken, sources, risk }) => { for (const t of ['依据', sources[0].no, risk ? '风险' : '']) onToken(t); return '依据' + sources[0].no; };

before(async () => {
  server = createApp({ reviewContract: fakeReview, answer: fakeAnswer }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function sse(url, body) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((b) => ({ event: b.match(/event: (.*)/)[1], data: JSON.parse(b.match(/data: (.*)/)[1]) }));
}

test('health / 静态页面', async () => {
  assert.equal((await (await fetch(base + '/api/health')).json()).ok, true);
  assert.match(await (await fetch(base + '/')).text(), /合同哨兵/);
});

test('上传校验：非 PDF / 伪造 PDF / 空请求 / 扫描件', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['hello']), 'a.txt');
  let r = await fetch(base + '/api/contracts', { method: 'POST', body: fd });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'INVALID_TYPE');

  const fd2 = new FormData();
  fd2.append('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'fake.pdf');
  r = await fetch(base + '/api/contracts', { method: 'POST', body: fd2 });
  assert.equal((await r.json()).error.code, 'INVALID_TYPE');

  r = await fetch(base + '/api/contracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await r.json()).error.code, 'NO_FILE');

  // 最小合法 PDF（无文字）→ 扫描件提示
  const blank = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const fd3 = new FormData();
  fd3.append('file', new Blob([blank], { type: 'application/pdf' }), 'scan.pdf');
  r = await fetch(base + '/api/contracts', { method: 'POST', body: fd3 });
  assert.equal((await r.json()).error.code, 'SCANNED_PDF');
});

test('完整流程：上传 → 审查 SSE → 追问 SSE → 导出 → 埋点', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(new URL('../samples/sample-contract.pdf', import.meta.url))], { type: 'application/pdf' }), '我的合同.pdf');
  const up = await (await fetch(base + '/api/contracts', { method: 'POST', body: fd })).json();
  assert.equal(up.fileName, '我的合同.pdf');
  assert.equal(up.clauses.length, 16);

  let r = await fetch(`${base}/api/contracts/${up.id}/report`);
  assert.equal(r.status, 409);

  const evs = await sse(`/api/contracts/${up.id}/review`);
  assert.ok(evs.some((e) => e.event === 'progress'));
  assert.equal(evs.at(-1).event, 'result');
  assert.equal(evs.at(-1).data.score, 85);

  const chat = await sse(`/api/contracts/${up.id}/chat`, { question: '打官司去哪里？', riskId: 'r1' });
  assert.equal(chat[0].event, 'sources');
  assert.equal(chat[0].data.clauses[0].no, '第十四条');
  assert.ok(chat.filter((e) => e.event === 'token').length >= 2);
  assert.equal(chat.at(-1).event, 'done');

  r = await fetch(`${base}/api/contracts/${up.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"question":""}' });
  assert.equal(r.status, 400);

  r = await fetch(`${base}/api/contracts/${up.id}/report`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''/);
  const html = await r.text();
  assert.match(html, /合同风险审查报告/);
  assert.match(html, /不构成法律意见/);

  const m = await (await fetch(base + '/api/metrics')).json();
  assert.ok(m.counts.review_done >= 1 && m.counts.export >= 1);
  assert.ok(m.funnel.askRate > 0 && m.funnel.exportRate > 0);
});

test('不存在的会话 → 404', async () => {
  const r = await fetch(base + '/api/contracts/nope/report');
  assert.equal(r.status, 404);
});
