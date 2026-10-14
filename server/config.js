import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  port: Number(process.env.PORT || 3000),
  llm: {
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: (process.env.LLM_BASE_URL || 'https://llm-proxy.forgeax.com/v1').replace(/\/+$/, ''),
    model: process.env.LLM_MODEL || 'glm/glm-5.3',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 180000),
  },
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024,
  maxChars: Number(process.env.MAX_CHARS || 60000),
  minChars: 100,
};

export function assertConfig() {
  if (!config.llm.apiKey) {
    console.error('[合同哨兵] 缺少 LLM_API_KEY：请复制 .env.example 为 .env 并填写。本项目不提供演示模式。');
    process.exit(1);
  }
}
