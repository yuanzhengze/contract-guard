// OpenAI 兼容客户端：基于全局 fetch，统一走 SSE 流式。
// 用“空闲超时”（连续 N 秒没有任何字节，含推理过程）判断卡死，而不是总超时——
// 推理模型可能思考很久但一直在输出，真正卡死的请求则能被快速发现并重试。
import { config } from './config.js';
import { AppError } from './errors.js';

const IDLE_MS = Number(process.env.LLM_IDLE_MS || 45000);
const RETRYABLE = new Set(['LLM_NETWORK', 'LLM_RATE_LIMIT', 'LLM_ERROR', 'LLM_TIMEOUT', 'LLM_STALLED']);

function httpError(status) {
  if (status === 401 || status === 403) return new AppError('LLM_AUTH', 'AI 服务鉴权失败，请检查 API Key', 502);
  if (status === 429) return new AppError('LLM_RATE_LIMIT', 'AI 服务繁忙（限流），请稍后重试', 503);
  return new AppError('LLM_ERROR', `AI 服务暂时不可用（${status}），请重试`, 502);
}

// 单次流式请求：onDelta({ content, reasoning })；返回完整 content
async function streamOnce(body, { signal, onDelta }) {
  const ctrl = new AbortController();
  let reason = null;
  const abort = (r) => { reason = reason || r; ctrl.abort(); };
  const total = setTimeout(() => abort('timeout'), config.llm.timeoutMs);
  let idle;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => abort('stalled'), IDLE_MS); };
  const onUser = () => abort('user');
  signal?.addEventListener('abort', onUser);
  if (signal?.aborted) abort('user');
  kick();
  let content = '';
  try {
    const res = await fetch(config.llm.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({ model: config.llm.model, stream: true, ...body }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error('[llm] HTTP', res.status, (await res.text().catch(() => '')).slice(0, 300));
      throw httpError(res.status);
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      kick();
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return content;
        let delta;
        try { delta = JSON.parse(payload).choices?.[0]?.delta; } catch { continue; }
        if (!delta) continue;
        const c = delta.content || '';
        const r = delta.reasoning_content || '';
        if (c) content += c;
        if (c || r) onDelta?.({ content: c, reasoning: r });
      }
    }
    return content;
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (reason === 'user') { const err = new AppError('ABORTED', '已停止', 499); err.partial = content; throw err; }
    if (reason === 'stalled') throw new AppError('LLM_STALLED', `AI 服务 ${IDLE_MS / 1000} 秒无响应，请重试`, 504);
    if (reason === 'timeout') throw new AppError('LLM_TIMEOUT', 'AI 响应超时，请重试', 504);
    console.error('[llm] network', e.message, e.cause?.code || '');
    throw new AppError(content ? 'LLM_STREAM' : 'LLM_NETWORK', content ? 'AI 回答中断，请重试' : '无法连接 AI 服务，请检查网络后重试', 502);
  } finally {
    clearTimeout(total); clearTimeout(idle);
    signal?.removeEventListener('abort', onUser);
  }
}

// 瞬时故障指数退避重试；鉴权失败、用户取消、已经向用户输出过内容时不重试
async function withRetry(fn, { signal, retries = 2, canRetry = () => true }) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= retries || !RETRYABLE.has(e.code) || signal?.aborted || !canRetry()) throw e;
      const wait = 800 * 2 ** i;
      console.warn(`[llm] ${e.code}，${wait}ms 后第 ${i + 1} 次重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// JSON 模式：内部流式（用于存活检测与真实进度），返回完整文本
export async function chatJSON(messages, { temperature = 0.1, maxTokens = 8000, signal, onProgress, onRetry } = {}) {
  let attempt = 0;
  return withRetry(async () => {
    if (attempt++) onRetry?.(attempt - 1);
    const stats = { content: 0, reasoning: 0, text: '' };
    const content = await streamOnce(
      { messages, temperature, max_tokens: maxTokens, response_format: { type: 'json_object' } },
      { signal, onDelta: (d) => { stats.content += d.content.length; stats.reasoning += d.reasoning.length; stats.text += d.content; onProgress?.(stats); } },
    );
    return { content };
  }, { signal });
}

// 对话流式：一旦向用户输出过 token 就不再重试（避免重复内容）
export async function chatStream(messages, onToken, { temperature = 0.3, maxTokens = 2000, signal } = {}) {
  let emitted = false;
  try {
    return await withRetry(() => streamOnce(
      { messages, temperature, max_tokens: maxTokens },
      { signal, onDelta: (d) => { if (d.content) { emitted = true; onToken(d.content); } } },
    ), { signal, canRetry: () => !emitted });
  } catch (e) {
    if (e.code === 'ABORTED') return e.partial || '';
    throw e;
  }
}

// 容错解析：剥离 ```json 包裹、截取首尾大括号
export function parseJSONLoose(text) {
  const t = (text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* 继续 */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('invalid json');
}
