// 文本 → 条款数组（条款级切分，RAG 与原文定位的基础单元）
const ARTICLE = /^[ \t\u3000]*(第[一二三四五六七八九十百零〇\d]+条)[ \t\u3000]*([^\n]{0,30})/gm;
const NUMBERED = /^[ \t\u3000]*(\d{1,2})[\.、][ \t\u3000]*(?!\d)([^\n]{0,30})/gm;

function headTitle(text) {
  const first = text.trim().split('\n')[0] || '';
  return first.length > 20 ? first.slice(0, 20) + '…' : first;
}

export function splitClauses(fullText) {
  let marks = [...fullText.matchAll(ARTICLE)].map((m) => ({ index: m.index, no: m[1], title: m[2].trim() }));
  if (marks.length < 2) {
    marks = [...fullText.matchAll(NUMBERED)].map((m) => ({ index: m.index, no: m[1] + '.', title: m[2].trim() }));
  }
  const clauses = [];
  const push = (no, title, start, end) => {
    const text = fullText.slice(start, end);
    if (!text.trim()) return;
    clauses.push({ id: 'c' + (clauses.length + 1), no, title: (title || headTitle(text)).slice(0, 30), text, start, end });
  };
  if (marks.length >= 2) {
    if (marks[0].index > 0) push('前言', '合同首部', 0, marks[0].index);
    marks.forEach((m, i) => push(m.no, m.title, m.index, i + 1 < marks.length ? marks[i + 1].index : fullText.length));
    return clauses;
  }
  // 无编号：按空行分段，过长段落按句号再切
  const re = /\n\s*\n/g;
  let last = 0, m, n = 0;
  const pieces = [];
  while ((m = re.exec(fullText))) { pieces.push([last, m.index]); last = m.index + m[0].length; }
  pieces.push([last, fullText.length]);
  for (const [s, e] of pieces) {
    if (e - s <= 1500) { push('段落' + ++n, '', s, e); continue; }
    let cs = s;
    while (cs < e) {
      let ce = Math.min(e, cs + 1200);
      const dot = fullText.lastIndexOf('。', ce);
      if (ce < e && dot > cs + 200) ce = dot + 1;
      push('段落' + ++n, '', cs, ce);
      cs = ce;
    }
  }
  return clauses;
}

export function findClauseAt(clauses, offset) {
  if (offset == null) return null;
  return clauses.find((c) => offset >= c.start && offset < c.end) || null;
}
