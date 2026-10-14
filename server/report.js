// 导出：独立 HTML 审查报告（内联样式，可打印 / 另存为 PDF）
import { CATEGORY_NAME, LEVEL_NAME, SCORE_RULE } from './checklist.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLOR = { high: '#DC2626', medium: '#EA580C', low: '#16A34A' };
export const DISCLAIMER = '本报告由 AI 生成，仅供参考，不构成法律意见。重要合同请咨询专业律师。';

export function renderReport(contract, now = new Date()) {
  const r = contract.review;
  const scoreColor = r.score >= 80 ? '#16A34A' : r.score >= 60 ? '#EA580C' : '#DC2626';
  const rows = r.risks.map((x, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><span class="lv" style="background:${COLOR[x.level]}">${LEVEL_NAME[x.level]}</span></td>
      <td>${esc(CATEGORY_NAME[x.category])}<div class="muted">${esc(x.clauseNo || '未定位')}</div></td>
      <td><b>${esc(x.title)}</b><blockquote>${esc(x.quote)}</blockquote><p>${esc(x.explanation)}</p></td>
      <td>${esc(x.suggestion)}</td>
    </tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>合同审查报告 - ${esc(contract.fileName)}</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:#111827;max-width:1000px;margin:32px auto;padding:0 24px;line-height:1.6}
h1{font-size:24px;margin:0 0 4px}.muted{color:#6B7280;font-size:12px}
.overview{display:flex;gap:24px;align-items:center;border:1px solid #E5E7EB;border-radius:12px;padding:20px;margin:20px 0}
.score{font-size:44px;font-weight:700;color:${scoreColor}}.cnt span{display:inline-block;margin-right:16px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #E5E7EB;padding:8px;vertical-align:top;text-align:left}
th{background:#F9FAFB}td:nth-child(1){width:28px}td:nth-child(2){width:64px}td:nth-child(3){width:90px}td:nth-child(5){width:30%}
.lv{color:#fff;border-radius:4px;padding:2px 6px;font-size:12px;white-space:nowrap}
blockquote{margin:6px 0;padding:6px 10px;background:#F3F4F6;border-left:3px solid #9CA3AF;color:#374151}
p{margin:4px 0}.disc{margin-top:24px;padding:12px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;font-size:12px;color:#92400E}
@media print{body{margin:0}tr{page-break-inside:avoid}}
</style></head><body>
<h1>合同风险审查报告</h1>
<div class="muted">文件：${esc(contract.fileName)} ｜ 合同类型：${esc(r.contractType)} ｜ 审查立场：乙方（${esc(r.parties.us)}） ｜ 生成时间：${now.toLocaleString('zh-CN', { hour12: false })} ｜ 由「合同哨兵」生成</div>
<div class="overview"><div><div class="score">${r.score}</div><div class="muted">安全评分 / 100</div></div>
<div><div class="cnt"><span style="color:${COLOR.high}">高风险 ${r.counts.high}</span><span style="color:${COLOR.medium}">中风险 ${r.counts.medium}</span><span style="color:${COLOR.low}">低风险 ${r.counts.low}</span></div>
<div style="margin-top:6px"><b>总评：</b>${esc(r.summary)}</div><div class="muted">评分规则：${SCORE_RULE}（规则计算，不由 AI 打分）</div></div></div>
<table><thead><tr><th>#</th><th>等级</th><th>类别/条款</th><th>风险与原文</th><th>修改建议</th></tr></thead><tbody>${rows || '<tr><td colspan="5">未发现明显风险条款</td></tr>'}</tbody></table>
<div class="disc">⚠️ ${DISCLAIMER}</div>
</body></html>`;
}
