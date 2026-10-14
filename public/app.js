// 合同哨兵前端：原生 JS，无构建
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 极简 Markdown：粗体 / 列表 / 引用 / 标题（先转义，杜绝 XSS）
const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
function md(src) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(src).split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)、]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    close();
    if ((m = line.match(/^&gt;\s?(.*)/))) out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    else if ((m = line.match(/^#{1,4}\s+(.*)/))) out.push(`<div class="h">${inline(m[1])}</div>`);
    else if (!line.trim()) out.push('<div class="gap"></div>');
    else out.push(`<div>${inline(line)}</div>`);
  }
  close();
  return out.join('');
}
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s) {
  if (/^\d+$/.test(s)) return +s;
  if (s === '十') return 10;
  const [a, b] = s.split('十');
  if (s.includes('十')) return (a ? CN_NUM[a] : 1) * 10 + (b ? CN_NUM[b] : 0);
  return CN_NUM[s] || 0;
}
// 回答是否引用了某条款：支持「第四条」「第4条」「第4.3条」「4.3条」「按4.3」
function cites(text, no) {
  if (text.includes(no)) return true;
  const m = no.match(/^第(.+)条$/);
  const n = m ? cnToInt(m[1]) : parseInt(no, 10);
  if (!n) return false;
  return new RegExp(`(第|按|依据|根据|见|（|\\(|^|\\s)${n}(\\.\\d+|\\s*条)`).test(text) || new RegExp(`第${n}(\\.\\d+)?条`).test(text);
}

const LEVEL = { high: '高风险', medium: '中风险', low: '低风险' };
let CATEGORY = {};
const state = { contract: null, review: null, filter: 'all', chatCtrl: null, pendingRisk: null, file: null };

// ---------- 工具 ----------
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}
function track(name, props) {
  fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, contractId: state.contract?.id, props }) }).catch(() => {});
}
function show(view) {
  for (const v of ['landing', 'reviewing', 'report']) $('#view-' + v).classList.toggle('hidden', v !== view);
}
async function apiError(res) {
  try { return (await res.json()).error?.message || `请求失败（${res.status}）`; } catch { return `请求失败（${res.status}）`; }
}
// POST + SSE 解析（EventSource 不支持 POST）
async function postSSE(url, body, onEvent, signal) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal });
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) throw new Error(await apiError(res));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = 'message', data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(ev, JSON.parse(data));
    }
  }
}

// ---------- 初始化 ----------
async function init() {
  track('page_view');
  try {
    const h = await (await fetch('/api/health')).json();
    $('#engine').textContent = `AI 引擎：${h.model.split('/').pop().toUpperCase()}`;
  } catch { $('#engine').textContent = 'AI 引擎未连接'; $('#engine').classList.add('err'); }
  try {
    const { checklist } = await (await fetch('/api/checklist')).json();
    CATEGORY = Object.fromEntries(checklist.map((c) => [c.key, c.name]));
    $('#checklist-preview').innerHTML = '<div class="cap">AI 会逐项检查以下 10 类风险</div>' + checklist.map((c) => `<span class="chip" title="${esc(c.points)}">${esc(c.name)}</span>`).join('');
  } catch { /* 非关键 */ }

  const dz = $('#dropzone'), fi = $('#file');
  fi.addEventListener('change', () => fi.files[0] && uploadFile(fi.files[0]));
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => e.dataTransfer.files[0] && uploadFile(e.dataTransfer.files[0]));
  $('#btn-sample').addEventListener('click', () => uploadFile(null));
  $('#btn-retry').addEventListener('click', () => startReview(true));
  $('#btn-back').addEventListener('click', reset);
  $('#btn-new').addEventListener('click', reset);
  $('#brand').addEventListener('click', (e) => { e.preventDefault(); reset(); });
  $('#btn-export').addEventListener('click', exportReport);
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendQuestion(); });
  $('#question').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendQuestion(); } });
}

function reset() {
  state.chatCtrl?.abort();
  Object.assign(state, { contract: null, review: null, filter: 'all', chatCtrl: null, pendingRisk: null });
  $('#file').value = '';
  $('#messages').innerHTML = $('#messages').firstElementChild.outerHTML;
  show('landing');
}

// ---------- 上传 ----------
async function uploadFile(file) {
  if (file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return toast('仅支持 PDF 格式的合同文件', true);
    if (file.size > 10 * 1024 * 1024) return toast('文件超过 10MB 上限，请压缩或拆分后上传', true);
  }
  setProgress({ step: 'parse', label: '正在上传并解析文档…', percent: 3 }, file ? file.name : '示例-软件开发服务合同.pdf');
  show('reviewing');
  try {
    let res;
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      res = await fetch('/api/contracts', { method: 'POST', body: fd });
    } else {
      res = await fetch('/api/contracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sample: true }) });
    }
    if (!res.ok) throw new Error(await apiError(res));
    state.contract = await res.json();
    startReview(false);
  } catch (e) {
    show('landing');
    toast(e.message || '上传失败，请重试', true);
  }
}

// ---------- 审查 ----------
const STEP_ORDER = ['parse', 'split', 'analyze', 'verify', 'done'];
function setProgress(p, fileName) {
  if (fileName) $('#pc-file').textContent = '📄 ' + fileName;
  const idx = STEP_ORDER.indexOf(p.step);
  $$('#steps li').forEach((li, i) => { li.className = i < idx || p.step === 'done' ? 'done' : i === idx ? 'active' : ''; });
  $('#bar-fill').style.width = (p.percent || 0) + '%';
  const l = $('#pc-label'); l.textContent = p.label; l.classList.remove('err');
  $('#pc-actions').classList.add('hidden');
}
async function startReview(force) {
  const c = state.contract;
  setProgress({ step: 'split', label: `已识别 ${c.clauses.length} 个条款，正在提交 AI 审查…`, percent: 20 }, c.fileName);
  show('reviewing');
  let gotResult = false;
  try {
    await postSSE(`/api/contracts/${c.id}/review`, { force }, (ev, data) => {
      if (ev === 'progress') setProgress(data);
      else if (ev === 'result') { gotResult = true; state.review = data; renderReport(); }
      else if (ev === 'error') throw new Error(data.message);
    });
    if (!gotResult) throw new Error('审查连接意外中断，请重试');
  } catch (e) {
    const active = $('#steps li.active');
    if (active) active.className = 'fail';
    const l = $('#pc-label'); l.textContent = '审查失败：' + (e.message || '未知错误'); l.classList.add('err');
    $('#pc-actions').classList.remove('hidden');
  }
}

// ---------- 报告 ----------
function renderReport() {
  const { contract: c, review: r } = state;
  $('#rh-file').textContent = c.fileName;
  $('#rh-meta').textContent = `${r.contractType} ｜ 审查立场：乙方（${r.parties.us}） ｜ 对方：${r.parties.them} ｜ ${c.clauses.length} 个条款 · ${c.charCount} 字 ｜ AI 用时 ${(r.durationMs / 1000).toFixed(0)} 秒`;
  const color = r.score >= 80 ? 'var(--low)' : r.score >= 60 ? 'var(--medium)' : 'var(--high)';
  $('#overview').innerHTML = `
    <div class="ring" style="--p:${r.score};--c:${color}"><div><b>${r.score}</b><small>安全评分</small></div></div>
    <div class="ov-counts">
      ${['high', 'medium', 'low'].map((l) => `<button class="cnt ${l}" data-filter="${l}"><b>${r.counts[l]}</b><span>${LEVEL[l]}</span></button>`).join('')}
    </div>
    <div class="ov-summary"><div class="s">${esc(r.summary)}</div><div class="muted">评分规则：每个高风险扣当前分 15%、中风险 7%、低风险 2%（规则计算，不由 AI 打分，结果可复现）</div></div>`;
  $$('#overview .cnt').forEach((b) => b.addEventListener('click', () => { setFilter(b.dataset.filter); switchTab('risks'); }));
  renderDoc();
  renderFilters();
  renderCards();
  renderQuick();
  $('#risk-count').textContent = r.risks.length;
  switchTab('risks');
  show('report');
}

// 原文：按条款渲染，风险区间包 <mark>
function renderDoc() {
  const { contract: c, review: r } = state;
  const located = r.risks.filter((x) => x.located).sort((a, b) => a.start - b.start);
  const html = c.clauses.map((cl) => {
    let pos = cl.start, out = '';
    for (const x of located) {
      if (x.end <= cl.start || x.start >= cl.end) continue;
      const s = Math.max(x.start, cl.start, pos), e = Math.min(x.end, cl.end);
      if (e <= s) continue;
      out += esc(c.fullText.slice(pos, s));
      out += `<mark class="risk-${x.level}" data-risk="${x.id}" title="${esc(LEVEL[x.level] + '：' + x.title)}">${esc(c.fullText.slice(s, e))}</mark>`;
      pos = e;
    }
    out += esc(c.fullText.slice(pos, cl.end));
    return `<div class="clause" id="clause-${cl.id}" data-clause="${cl.id}">${out.replace(/^\n+|\n+$/g, '')}</div>`;
  }).join('');
  $('#doc').innerHTML = html;
  $$('#doc mark').forEach((m) => m.addEventListener('click', () => focusCard(m.dataset.risk)));
}

function renderFilters() {
  const r = state.review;
  const items = [['all', `全部 ${r.risks.length}`], ...['high', 'medium', 'low'].map((l) => [l, `${LEVEL[l]} ${r.counts[l]}`])];
  $('#filters').innerHTML = items.map(([k, t]) => `<button class="filter ${state.filter === k ? 'active' : ''}" data-f="${k}">${t}</button>`).join('');
  $$('#filters .filter').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.f)));
}
function setFilter(f) {
  state.filter = state.filter === f && f !== 'all' ? 'all' : f;
  renderFilters();
  renderCards();
  $$('#doc mark').forEach((m) => {
    const risk = state.review.risks.find((x) => x.id === m.dataset.risk);
    m.classList.toggle('dim', state.filter !== 'all' && risk.level !== state.filter);
  });
}

function renderCards() {
  const list = state.review.risks.filter((x) => state.filter === 'all' || x.level === state.filter);
  if (!state.review.risks.length) { $('#cards').innerHTML = '<div class="empty">🎉 没有发现明显的风险条款</div>'; return; }
  if (!list.length) { $('#cards').innerHTML = '<div class="empty">该等级下没有风险</div>'; return; }
  $('#cards').innerHTML = list.map((x) => `
    <div class="card ${x.level}" id="card-${x.id}" data-risk="${x.id}">
      <div class="card-top"><span class="lv">${LEVEL[x.level]}</span><span class="cat">${esc(CATEGORY[x.category] || x.category)}</span><span class="cno">${x.located ? '📍 ' + esc(x.clauseNo || '') : ''}</span></div>
      <h4>${esc(x.title)}</h4>
      <div class="q">“${esc(x.quote)}”</div>
      ${x.located ? '' : '<div class="warn">⚠ 未能在原文中精确定位该引用，请人工核对</div>'}
      <div class="exp">${esc(x.explanation)}</div>
      <div class="sug"><b>建议修改：</b>${esc(x.suggestion)}</div>
      <div class="card-actions">
        <button class="btn sm" data-act="copy">复制建议</button>
        <button class="btn sm" data-act="ask">💬 追问这条</button>
      </div>
    </div>`).join('');
  $$('#cards .card').forEach((card) => card.addEventListener('click', (e) => {
    const id = card.dataset.risk;
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'copy') return copySuggestion(id);
    if (act === 'ask') return askAbout(id);
    focusMark(id);
  }));
}

function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
function focusMark(id) {
  const m = $(`#doc mark[data-risk="${id}"]`);
  if (!m) return toast('该风险未能在原文中定位');
  m.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(m);
}
function focusCard(id) {
  switchTab('risks');
  const risk = state.review.risks.find((x) => x.id === id);
  if (state.filter !== 'all' && risk.level !== state.filter) setFilter('all');
  const card = $('#card-' + id);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(card);
}
function focusClause(cid) {
  const el = $('#clause-' + cid);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(el);
}
async function copySuggestion(id) {
  const x = state.review.risks.find((r) => r.id === id);
  const text = `【${x.title}】\n原文：${x.quote}\n建议修改：${x.suggestion}`;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('修改建议已复制，可直接发给对方');
  track('copy_suggestion', { riskId: id });
}

function exportReport() {
  track('export');
  const a = document.createElement('a');
  a.href = `/api/contracts/${state.contract.id}/report`;
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  toast('报告已下载，用浏览器打开后可打印或另存为 PDF');
}

// ---------- 追问 ----------
function switchTab(tab) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#tab-risks').classList.toggle('hidden', tab !== 'risks');
  $('#tab-chat').classList.toggle('hidden', tab !== 'chat');
  if (tab === 'chat') setTimeout(() => $('#question').focus(), 50);
}
function renderQuick() {
  const qs = ['这份合同最需要先改哪一条？', '如果对方违约，我能获得什么赔偿？', '合同能否提前解除？要付出什么代价？'];
  $('#quick').innerHTML = qs.map((q) => `<button type="button">${esc(q)}</button>`).join('');
  $$('#quick button').forEach((b) => b.addEventListener('click', () => { $('#question').value = b.textContent; sendQuestion(); }));
}
function setCtx(risk) {
  state.pendingRisk = risk;
  const ctx = $('#ctx');
  if (!risk) return ctx.classList.add('hidden');
  ctx.innerHTML = `<span>💬 正在追问：${esc(risk.title)}</span><button type="button" title="取消">✕</button>`;
  ctx.classList.remove('hidden');
  ctx.querySelector('button').onclick = () => setCtx(null);
}
function askAbout(id) {
  const risk = state.review.risks.find((x) => x.id === id);
  track('risk_ask_clicked', { riskId: id });
  switchTab('chat');
  setCtx(risk);
  $('#question').value = '这条风险具体会让我损失什么？我应该怎么和对方谈？';
  $('#question').select();
}
function addMsg(role, html, cls = '') {
  const div = document.createElement('div');
  div.className = `msg ${role} ${cls}`;
  div.innerHTML = html;
  $('#messages').appendChild(div);
  $('#messages').scrollTop = 1e9;
  return div;
}
function setSending(on) {
  const b = $('#btn-send');
  b.textContent = on ? '停止' : '发送';
  b.classList.toggle('primary', !on);
  b.type = on ? 'button' : 'submit';
  b.onclick = on ? () => state.chatCtrl?.abort() : null;
}
async function sendQuestion() {
  if (state.chatCtrl) return;
  const q = $('#question').value.trim();
  if (!q) return;
  const risk = state.pendingRisk;
  $('#question').value = '';
  setCtx(null);
  addMsg('user', (risk ? `<div class="ctxline">追问：${esc(risk.title)}</div>` : '') + esc(q));
  const bubble = addMsg('assistant', '<div class="body cursor"></div>');
  const body = bubble.querySelector('.body');
  let text = '', sources = [];
  state.chatCtrl = new AbortController();
  setSending(true);
  try {
    await postSSE(`/api/contracts/${state.contract.id}/chat`, { question: q, riskId: risk?.id }, (ev, data) => {
      if (ev === 'sources') sources = data.clauses;
      else if (ev === 'token') { text += data.t; body.innerHTML = md(text); $('#messages').scrollTop = 1e9; }
      else if (ev === 'error') throw new Error(data.message);
    }, state.chatCtrl.signal);
  } catch (e) {
    if (e.name === 'AbortError') text += text ? '\n\n（已停止）' : '（已停止）';
    else { bubble.classList.add('error'); text = (text ? text + '\n\n' : '') + '⚠ ' + (e.message || '回答失败，请重试'); }
    body.innerHTML = md(text);
  } finally {
    body.classList.remove('cursor');
    state.chatCtrl = null;
    setSending(false);
  }
  if (sources.length && !bubble.classList.contains('error')) {
    // 优先展示回答中实际提到的条款
    // 追问的风险所在条款始终展示
    const cited = sources.filter((s) => s.id === risk?.clauseId || cites(text, s.no));
    const shown = cited.length ? cited : sources;
    const refs = document.createElement('div');
    refs.className = 'refs';
    refs.innerHTML = `<span>参考条款：</span>` + shown.map((s) => `<button class="ref" data-c="${s.id}" title="${esc(s.snippet)}">${esc(s.no)} ${esc(s.title || '')}</button>`).join('');
    bubble.appendChild(refs);
    refs.querySelectorAll('.ref').forEach((b) => b.addEventListener('click', () => focusClause(b.dataset.c)));
  }
  $('#messages').scrollTop = 1e9;
}

init();
