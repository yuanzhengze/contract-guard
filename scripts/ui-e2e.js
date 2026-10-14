// 前端端到端（jsdom）：真实页面 + 真实后端 + 真实 LLM，模拟用户完整走查
// 用法：先 npm start，再 node scripts/ui-e2e.js [baseUrl]
import { JSDOM } from 'jsdom';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(200); }
  throw new Error('超时：' + label);
};
const ok = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) process.exitCode = 1; };

const html = await (await fetch(BASE + '/')).text();
const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const d = window.document;
// jsdom 不支持的浏览器 API 补齐；fetch 走 Node 原生，相对路径补全
Object.assign(window, { fetch: (u, o) => fetch(new URL(u, BASE), o), TextDecoder, AbortController });
window.HTMLElement.prototype.scrollIntoView = function () { window.__scrolled = this; };
let copied = '';
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } } });
const downloads = [];
window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.href); };
window.eval((await (await fetch(BASE + '/app.js')).text()));

const $ = (s) => d.querySelector(s);
await waitFor(() => /GLM/.test($('#engine').textContent), 5000, '模型徽标');
ok(true, '落地页加载，徽标：' + $('#engine').textContent);
ok(d.querySelectorAll('#checklist-preview .chip').length === 10, '展示 10 类审查清单');

const t0 = Date.now();
$('#btn-sample').click();
await waitFor(() => !$('#view-reviewing').classList.contains('hidden'), 3000, '进入审查页');
const labels = new Set();
await waitFor(() => { labels.add($('#pc-label').textContent); return !$('#view-report').classList.contains('hidden') || !$('#pc-actions').classList.contains('hidden'); }, 240000, '审查完成');
ok(!$('#view-report').classList.contains('hidden'), `真实审查完成，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s；进度文案 ${labels.size} 种，如：${[...labels].slice(2, 5).join(' / ')}`);
if ($('#view-report').classList.contains('hidden')) { console.log('失败信息：', $('#pc-label').textContent); process.exit(1); }

const cards = d.querySelectorAll('#cards .card');
const marks = d.querySelectorAll('#doc mark');
ok(cards.length > 0, `风险卡片 ${cards.length} 张；总评：${d.querySelector('.ov-summary .s').textContent}`);
ok(marks.length > 0, `原文高亮 ${marks.length} 处；评分 ${d.querySelector('.ring b').textContent}`);
ok(d.querySelectorAll('#doc .clause').length === 16, '原文按 16 个条款渲染');

cards[0].click();
ok(window.__scrolled?.tagName === 'MARK' && window.__scrolled.dataset.risk === cards[0].dataset.risk, '点击卡片 → 原文对应高亮滚动定位');
marks[marks.length - 1].click();
ok(window.__scrolled?.classList.contains('card') && window.__scrolled.dataset.risk === marks[marks.length - 1].dataset.risk, '点击原文高亮 → 对应卡片滚动定位');

d.querySelector('.cnt.high').click();
const highOnly = [...d.querySelectorAll('#cards .card')].every((c) => c.classList.contains('high'));
ok(highOnly, `等级筛选：仅显示高风险 ${d.querySelectorAll('#cards .card').length} 张；非高风险原文高亮变淡 ${d.querySelectorAll('#doc mark.dim').length} 处`);
d.querySelector('#filters [data-f="all"]').click();

d.querySelector('#cards .card [data-act="copy"]').click();
await sleep(100);
ok(copied.includes('建议修改'), '复制建议：' + copied.split('\n')[0]);

// 追问这条（带风险上下文）
d.querySelector('#cards .card [data-act="ask"]').click();
ok(!$('#tab-chat').classList.contains('hidden') && !$('#ctx').classList.contains('hidden'), '“追问这条”切到追问 Tab 并带上风险上下文：' + $('#ctx').textContent.trim());
$('#composer').dispatchEvent(new window.Event('submit', { cancelable: true }));
await sleep(300);
ok($('#btn-send').textContent === '停止', '生成中按钮变为“停止”');
let maxLen = 0, growth = 0;
await waitFor(() => {
  const b = d.querySelector('#messages .msg.assistant:last-child .body');
  const len = b?.textContent.length || 0;
  if (len > maxLen) { growth++; maxLen = len; }
  return $('#btn-send').textContent === '发送';
}, 120000, '追问完成');
const last = d.querySelector('#messages .msg.assistant:last-child');
ok(growth >= 3, `流式输出：内容分 ${growth} 次增长到 ${maxLen} 字`);
const refs = [...last.querySelectorAll('.ref')].map((r) => r.textContent.trim());
ok(refs.length > 0, '参考条款 chips：' + refs.join('、'));
last.querySelector('.ref').click();
ok(window.__scrolled?.classList.contains('clause'), '点击参考条款 → 原文条款定位');
console.log('   回答摘要：' + last.querySelector('.body').textContent.slice(0, 120).replace(/\s+/g, ' ') + '…');

// 停止生成
$('#question').value = '把整份合同的所有风险按严重程度详细排个序，并逐条写出谈判话术';
$('#composer').dispatchEvent(new window.Event('submit', { cancelable: true }));
await waitFor(() => (d.querySelector('#messages .msg.assistant:last-child .body')?.textContent.length || 0) > 10, 60000, '开始输出');
$('#btn-send').click();
await waitFor(() => $('#btn-send').textContent === '发送', 10000, '停止生效');
ok(/已停止/.test(d.querySelector('#messages .msg.assistant:last-child').textContent), '“停止”可中断生成');

// 导出
$('#btn-export').click();
ok(downloads[0]?.endsWith('/report'), '导出触发下载：' + downloads[0]);
const rep = await fetch(downloads[0]);
const rhtml = await rep.text();
ok(rep.ok && /合同风险审查报告/.test(rhtml) && /不构成法律意见/.test(rhtml), `报告 HTML ${rhtml.length} 字节，含免责声明；文件名：${decodeURIComponent(rep.headers.get('content-disposition').split("''")[1])}`);

await sleep(300);
const m = await (await fetch(BASE + '/api/metrics')).json();
ok(m.counts.review_done >= 1 && m.counts.chat_sent >= 1 && m.counts.export >= 1, '埋点漏斗：' + JSON.stringify(m.funnel));
window.close();
process.exit(process.exitCode || 0);
