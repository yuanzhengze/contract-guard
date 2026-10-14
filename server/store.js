// 内存会话存储：不落盘，TTL 1 小时
import crypto from 'node:crypto';
import { buildIndex } from './retriever.js';

const TTL = 60 * 60 * 1000;
const contracts = new Map();

export function createContract({ fileName, fullText, clauses, isSample }) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const c = { id, fileName, fullText, clauses, isSample, review: null, reviewing: null, chatHistory: [], createdAt: Date.now(), index: buildIndex(clauses) };
  contracts.set(id, c);
  return c;
}
export const getContract = (id) => {
  const c = contracts.get(id);
  if (c && Date.now() - c.createdAt > TTL) { contracts.delete(id); return null; }
  return c || null;
};
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of contracts) if (now - c.createdAt > TTL) contracts.delete(id);
}, 10 * 60 * 1000).unref();
