// 风险审查清单 —— 产品核心资产（与 PRODUCT_PLAN §6 一致）
export const CHECKLIST = [
  { key: 'payment', name: '付款条款', points: '付款节点与账期是否过长、预付比例是否过低、尾款比例是否过高、逾期付款责任是否对等、开票与付款是否被不合理绑定' },
  { key: 'liability', name: '违约责任', points: '违约金是否畸高或畸低、违约责任是否只约束我方、对方违约是否有对等责任' },
  { key: 'termination', name: '解除与终止', points: '对方是否有任意单方解除权、我方解除条件是否苛刻、解除后已完成工作如何结算' },
  { key: 'renewal', name: '自动续约', points: '是否默认自动续约、续约是否涨价、退出通知期是否过长' },
  { key: 'indemnity', name: '责任限制与赔偿', points: '我方是否承担无上限责任、是否包含间接损失/利润损失、对方责任是否有上限' },
  { key: 'ip', name: '知识产权', points: '成果归属是否明确、我方既有技术/通用组件是否被一并转让、授权范围是否过宽' },
  { key: 'confidentiality', name: '保密条款', points: '保密义务是否单方、期限是否合理、违约后果是否过重' },
  { key: 'dispute', name: '争议解决', points: '管辖法院/仲裁地是否在对方所在地、争议解决方式是否对我方不利' },
  { key: 'acceptance', name: '交付与验收', points: '验收标准是否明确、验收期限是否由对方单方决定、是否有逾期视为验收的保护' },
  { key: 'other', name: '其他不公平条款', points: '对方单方变更权（需求/价格/工期）、免责条款过宽、排他或竞业限制、人员与费用不合理约束' },
];
export const CATEGORY_KEYS = CHECKLIST.map((c) => c.key);
export const CATEGORY_NAME = Object.fromEntries(CHECKLIST.map((c) => [c.key, c.name]));
export const LEVELS = ['high', 'medium', 'low'];
export const LEVEL_NAME = { high: '高风险', medium: '中风险', low: '低风险' };

// 安全评分：规则计算，可解释、稳定（不让模型打分）
// 乘法递减：每个高风险扣掉当前分数的 15%，中风险 7%，低风险 2%。
// 相比线性扣分，风险很多的合同不会全部被压到 0 分，仍保留区分度。
export const SCORE_RULE = '每个高风险扣当前分 15%、中风险 7%、低风险 2%';
export function computeScore(counts) {
  return Math.round(100 * 0.85 ** counts.high * 0.93 ** counts.medium * 0.98 ** counts.low);
}
