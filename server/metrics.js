// 埋点：追加写入 logs/events.jsonl，汇总漏斗
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const DIR = path.join(ROOT, 'logs');
const FILE = path.join(DIR, 'events.jsonl');
export const EVENT_NAMES = ['page_view', 'upload', 'sample_used', 'review_done', 'review_failed', 'chat_sent', 'risk_ask_clicked', 'export', 'copy_suggestion'];

export function track(name, contractId = null, props = {}) {
  if (!EVENT_NAMES.includes(name)) return false;
  fs.mkdirSync(DIR, { recursive: true });
  const safe = {};
  for (const [k, v] of Object.entries(props || {}).slice(0, 10)) if (['string', 'number', 'boolean'].includes(typeof v)) safe[k] = typeof v === 'string' ? v.slice(0, 80) : v;
  fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), name, contractId, props: safe }) + '\n');
  return true;
}

export function summary() {
  const counts = Object.fromEntries(EVENT_NAMES.map((n) => [n, 0]));
  const sets = { review_done: new Set(), chat_sent: new Set(), export: new Set() };
  let durations = [];
  if (fs.existsSync(FILE)) {
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        counts[e.name] = (counts[e.name] || 0) + 1;
        if (sets[e.name] && e.contractId) sets[e.name].add(e.contractId);
        if (e.name === 'review_done' && e.props?.durationMs) durations.push(e.props.durationMs);
      } catch { /* skip */ }
    }
  }
  const reviewed = sets.review_done.size;
  const rate = (s) => (reviewed ? +([...s].filter((id) => sets.review_done.has(id)).length / reviewed).toFixed(3) : 0);
  durations.sort((a, b) => a - b);
  return {
    counts,
    funnel: {
      reviewedContracts: reviewed,
      askRate: rate(sets.chat_sent),
      exportRate: rate(sets.export),
      northStar: [...sets.review_done].filter((id) => sets.chat_sent.has(id) || sets.export.has(id)).length,
      medianReviewMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    },
  };
}
