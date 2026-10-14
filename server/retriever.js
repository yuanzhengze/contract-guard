// 条款级 BM25 检索：中文二元分词 + 英文/数字词。零依赖、零成本。
const STOP = new Set('的了和与或及在为是有对其之等'.split(''));

// 口语 → 合同用语的查询扩展（用户说“尾款/打官司/拖欠”，合同写“剩余款项/诉讼/逾期”）
const SYNONYMS = [
  [/尾款|余款|结款|回款|付钱|给钱|打款|账期|什么时候付/, '付款 支付 剩余 款项 合同金额 验收合格'],
  [/定金|首付|预付/, '预付款 支付'],
  [/赔偿|赔多少|赔钱|损失/, '赔偿 损失 违约金 责任'],
  [/违约|毁约|不履行/, '违约 违约责任 违约金'],
  [/拖欠|拖延|晚交|延期|逾期/, '逾期 违约金 期限'],
  [/解约|退出|终止|不干了|解除/, '解除 终止 通知'],
  [/打官司|起诉|法院|仲裁|纠纷|争议/, '争议 诉讼 法院 管辖 仲裁'],
  [/版权|知识产权|代码归|归谁|所有权/, '知识产权 归属 所有 源代码'],
  [/保密|泄露|机密/, '保密 商业秘密 披露'],
  [/验收|交付|交货|上线/, '验收 交付 标准 期限'],
  [/改需求|变更|加需求|需求/, '需求 变更 增加'],
  [/续约|续签|到期/, '续约 期限 届满'],
  [/发票|开票/, '发票 开具'],
  [/维护|售后|保修/, '维护 服务 缺陷修复'],
];
export function expandQuery(q) {
  const extra = SYNONYMS.filter(([re]) => re.test(q)).map(([, w]) => w);
  return extra.length ? q + ' ' + extra.join(' ') : q;
}

export function tokenize(text) {
  const tokens = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]+(?:[.%][0-9]+)?%?/g)) tokens.push(m[0]);
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = [...m[0]].filter((ch) => !STOP.has(ch));
    if (s.length === 1) tokens.push(s[0]);
    for (let i = 0; i + 1 < s.length; i++) tokens.push(s[i] + s[i + 1]);
  }
  return tokens;
}

export function buildIndex(clauses, { k1 = 1.5, b = 0.75 } = {}) {
  const docs = clauses.map((c) => {
    const toks = tokenize((c.title || '') + ' ' + c.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { clause: c, tf, len: toks.length };
  });
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

  return {
    search(query, k = 4) {
      const q = [...new Set(tokenize(expandQuery(query)))];
      const scored = docs.map((d) => {
        let score = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          score += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgdl));
        }
        return { clause: d.clause, score };
      });
      const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
      if (hits.length) return hits;
      return docs.slice(0, Math.min(k, docs.length)).map((d) => ({ clause: d.clause, score: 0 }));
    },
  };
}
