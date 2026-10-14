// 真实 LLM 评测：审查示例合同，计算预埋风险召回率与引用可定位率（SPEC A8）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assertConfig, config } from '../server/config.js';
import { pdfToText } from '../server/parser.js';
import { splitClauses } from '../server/clauses.js';
import { reviewContract } from '../server/reviewer.js';

assertConfig();
const runs = Number(process.argv[2] || 1);
const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/expected-risks.json'), 'utf8')).risks;
const fullText = await pdfToText(fs.readFileSync(path.join(ROOT, 'samples/sample-contract.pdf')));
const contract = { fullText, clauses: splitClauses(fullText) };
console.log(`模型 ${config.llm.model}｜条款 ${contract.clauses.length}｜字数 ${fullText.length}｜运行 ${runs} 次\n`);

const results = [];
for (let n = 1; n <= runs; n++) {
  const r = await reviewContract(contract);
  const hit = expected.map((e) => {
    const m = r.risks.find((x) => e.anyOf.some((k) => (x.quote + x.title + x.explanation).includes(k)));
    return { ...e, matched: m || null };
  });
  const recall = hit.filter((h) => h.matched).length;
  console.log(`— 第 ${n} 次：${(r.durationMs / 1000).toFixed(1)}s｜风险 ${r.risks.length} 条（高${r.counts.high}/中${r.counts.medium}/低${r.counts.low}）｜评分 ${r.score}`);
  for (const h of hit) console.log(`  ${h.matched ? '✅' : '❌'} ${h.id} ${h.name}${h.matched ? `  → [${h.matched.level}] ${h.matched.title}` : ''}`);
  const extra = r.risks.filter((x) => !hit.some((h) => h.matched === x));
  if (extra.length) console.log('  其他发现：' + extra.map((x) => `[${x.level}]${x.title}${x.located ? '' : '(未定位)'}`).join('；'));
  console.log(`  召回 ${recall}/${expected.length}｜引用可定位率 ${(r.locatedRate * 100).toFixed(0)}%\n`);
  results.push({ recall, locatedRate: r.locatedRate, durationMs: r.durationMs });
}
// 反向测试：条款对等的合同不应被大量误报
const fairText = await pdfToText(fs.readFileSync(path.join(ROOT, 'samples/fair-contract.pdf')));
const fair = await reviewContract({ fullText: fairText, clauses: splitClauses(fairText) });
const fairOk = fair.counts.high === 0 && fair.score >= 80;
console.log(`— 反向测试（对等合同）：评分 ${fair.score}｜高${fair.counts.high}/中${fair.counts.medium}/低${fair.counts.low}｜${fair.summary}｜${fairOk ? '✅ 无高风险误报' : '❌ 存在误报'}\n`);

const avg = (k) => results.reduce((s, x) => s + x[k], 0) / results.length;
const pass = results.every((x) => x.recall >= 7 && x.locatedRate >= 0.9) && fairOk;
console.log(`汇总：平均召回 ${avg('recall').toFixed(2)}/${expected.length}｜平均定位率 ${(avg('locatedRate') * 100).toFixed(0)}%｜平均耗时 ${(avg('durationMs') / 1000).toFixed(1)}s｜${pass ? '✅ 通过 A8' : '❌ 未通过 A8'}`);
process.exit(pass ? 0 : 1);
