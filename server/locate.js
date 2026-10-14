// 引用定位：把模型给出的 quote 映射回原文偏移，防幻觉的关键环节
const PUNCT_MAP = { '，': ',', '。': '.', '；': ';', '：': ':', '（': '(', '）': ')', '“': '"', '”': '"', '‘': "'", '’': "'", '！': '!', '？': '?', '、': ',', '【': '[', '】': ']', '％': '%' };

// 归一化：去空白、统一标点与全角字母数字；同时记录每个归一化字符对应的原文下标
export function normalizeWithMap(s) {
  let norm = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (/\s/.test(ch)) continue;
    const code = ch.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e && !PUNCT_MAP[ch]) ch = String.fromCharCode(code - 0xfee0);
    ch = PUNCT_MAP[ch] || ch;
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

export function locateQuote(fullText, quote, normCache) {
  if (!quote) return null;
  const q = quote.trim().replace(/^[“"'「]|[”"'」]$/g, '').replace(/(\.\.\.|…+)$/g, '');
  if (!q) return null;
  const exact = fullText.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };
  const full = normCache || normalizeWithMap(fullText);
  const nq = normalizeWithMap(q).norm;
  if (nq.length < 4) return null;
  const at = full.norm.indexOf(nq);
  if (at >= 0) return { start: full.map[at], end: full.map[at + nq.length - 1] + 1 };
  // 模型可能拼接了同一条款中不相邻的句子（有/无省略号）：按标点拆段分别定位，
  // 覆盖率足够且彼此相距不远时，返回覆盖这些片段的原文区间（展示的永远是真实原文）
  const segs = q.split(/\.\.\.|…+|[，。；,;：:！？!?]/).map((p) => normalizeWithMap(p).norm).filter((p) => p.length >= 6);
  const found = [];
  let cursor = 0;
  for (const seg of segs) {
    let pos = full.norm.indexOf(seg, cursor);
    if (pos < 0) pos = full.norm.indexOf(seg);
    if (pos >= 0) { found.push([pos, pos + seg.length]); cursor = pos + seg.length; }
  }
  if (!found.length) return null;
  const coverage = found.reduce((n, [a, b]) => n + (b - a), 0) / nq.length;
  const lo = Math.min(...found.map((f) => f[0]));
  const hi = Math.max(...found.map((f) => f[1]));
  if (coverage < 0.6 || hi - lo > Math.max(400, nq.length * 2.5)) return null;
  return { start: full.map[lo], end: full.map[hi - 1] + 1 };
}
