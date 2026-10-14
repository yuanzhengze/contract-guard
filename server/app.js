// Express 应用（与 index.js 分离以便测试）
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, ROOT } from './config.js';
import { AppError, toErrorBody } from './errors.js';
import { pdfToText } from './parser.js';
import { splitClauses } from './clauses.js';
import { createContract, getContract } from './store.js';
import { reviewContract } from './reviewer.js';
import { selectSources, answer } from './chat.js';
import { renderReport } from './report.js';
import { CHECKLIST } from './checklist.js';
import { track, summary } from './metrics.js';

const SAMPLE_PDF = path.join(ROOT, 'samples/sample-contract.pdf');
const SAMPLE_NAME = '示例-软件开发服务合同.pdf';

export function createApp(deps = {}) {
  const review = deps.reviewContract || reviewContract;
  const answerFn = deps.answer || answer;
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  app.get('/samples/sample-contract.pdf', (req, res) => res.sendFile(SAMPLE_PDF));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });
  const uploadMw = (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    upload.single('file')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return next(new AppError('FILE_TOO_LARGE', `文件超过 ${config.maxUploadBytes / 1024 / 1024}MB 上限，请压缩或拆分后上传`, 413));
      next(err);
    });
  };

  app.get('/api/health', (req, res) => res.json({ ok: true, model: config.llm.model }));
  app.get('/api/checklist', (req, res) => res.json({ checklist: CHECKLIST }));

  app.post('/api/contracts', uploadMw, async (req, res, next) => {
    try {
      let buffer, fileName, isSample = false;
      if (req.file) {
        const isPdf = /\.pdf$/i.test(req.file.originalname) || req.file.mimetype === 'application/pdf';
        if (!isPdf || req.file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new AppError('INVALID_TYPE', '仅支持 PDF 格式的合同文件');
        buffer = req.file.buffer;
        fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      } else if (req.body?.sample) {
        buffer = fs.readFileSync(SAMPLE_PDF);
        fileName = SAMPLE_NAME;
        isSample = true;
      } else throw new AppError('NO_FILE', '请选择要上传的 PDF 合同');

      const fullText = await pdfToText(buffer);
      const chars = fullText.replace(/\s/g, '').length;
      if (chars < config.minChars) throw new AppError('SCANNED_PDF', '没有从文件中识别到足够的文字。暂不支持扫描件/图片版 PDF，请上传文字版 PDF');
      if (fullText.length > config.maxChars) throw new AppError('TOO_LONG', `合同过长（${fullText.length} 字，上限 ${config.maxChars} 字），请拆分后上传`);
      const clauses = splitClauses(fullText);
      const c = createContract({ fileName, fullText, clauses, isSample });
      track(isSample ? 'sample_used' : 'upload', c.id, { chars });
      res.json({ id: c.id, fileName, charCount: chars, fullText, clauses, isSample });
    } catch (e) { next(e); }
  });

  function sse(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    return (event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  }

  const need = (req) => {
    const c = getContract(req.params.id);
    if (!c) throw new AppError('NOT_FOUND', '会话已过期或不存在，请重新上传合同', 404);
    return c;
  };

  app.post('/api/contracts/:id/review', async (req, res, next) => {
    let c;
    try { c = need(req); } catch (e) { return next(e); }
    const send = sse(res);
    if (c.review && !req.body?.force && !c.reviewing) { send('result', c.review); return res.end(); }

    send('progress', { step: 'parse', label: '已解析文档', percent: 10 });
    send('progress', { step: 'split', label: `已识别 ${c.clauses.length} 个条款`, percent: 20 });
    // 进度 = 真实信号（模型在思考 / 已写出 N 条风险 / 正在重试）+ 平滑的百分比
    let i = 0, pct = 25, live = { phase: 'thinking' };
    const label = () => {
      if (live.phase === 'retry') return `AI 服务响应慢，正在自动重试（第 ${live.retry} 次）…`;
      if (live.phase === 'writing') return live.risksFound ? `已发现 ${live.risksFound} 处风险，正在整理报告…` : '审查完成，正在整理报告…';
      return `AI 正在检查${CHECKLIST[i++ % CHECKLIST.length].name}…`;
    };
    const tick = () => {
      const cap = live.phase === 'writing' ? 92 : 75;
      pct = Math.min(cap, pct + (cap - pct) * 0.1);
      send('progress', { step: 'analyze', label: label(), percent: Math.round(pct) });
    };
    tick();
    const timer = setInterval(tick, 2500);
    try {
      // 审查任务与连接解耦：用户刷新/断线不会中断审查，结果写入会话，重连即得（也避免重复消耗额度）
      if (!c.reviewing) {
        c.progressListeners = new Set();
        c.reviewing = review(c, { onProgress: (p) => c.progressListeners.forEach((fn) => fn(p)) })
          .then((r) => {
            c.review = r;
            track('review_done', c.id, { durationMs: r.durationMs, risks: r.risks.length, high: r.counts.high, locatedRate: r.locatedRate, sample: c.isSample });
            return r;
          }, (e) => { track('review_failed', c.id, { code: e.code || 'INTERNAL' }); throw e; })
          .finally(() => { c.reviewing = null; });
      }
      const listener = (p) => { const changed = p.phase !== live.phase || p.risksFound !== live.risksFound; live = p; if (changed && p.phase !== 'thinking') tick(); };
      c.progressListeners.add(listener);
      const result = await c.reviewing.finally(() => c.progressListeners.delete(listener));
      clearInterval(timer);
      send('progress', { step: 'verify', label: `已校验 ${result.risks.length} 条引用的原文位置`, percent: 95 });
      send('progress', { step: 'done', label: '报告已生成', percent: 100 });
      send('result', result);
    } catch (e) {
      clearInterval(timer);
      const body = toErrorBody(e).error;
      if (!(e instanceof AppError)) console.error('[review]', e);
      else console.warn('[review] 失败', e.code);
      send('error', body);
    }
    res.end();
  });

  app.post('/api/contracts/:id/chat', async (req, res, next) => {
    let c, question, risk;
    try {
      c = need(req);
      question = String(req.body?.question || '').trim();
      if (!question) throw new AppError('EMPTY_QUESTION', '请输入问题');
      if (question.length > 500) throw new AppError('QUESTION_TOO_LONG', '问题请控制在 500 字以内');
      risk = req.body?.riskId ? c.review?.risks.find((r) => r.id === req.body.riskId) : null;
    } catch (e) { return next(e); }
    const send = sse(res);
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    const sources = selectSources(c, c.index, question, risk);
    send('sources', { clauses: sources.map((s) => ({ id: s.id, no: s.no, title: s.title, snippet: s.text.trim().slice(0, 80) })) });
    track('chat_sent', c.id, { withRisk: !!risk });
    try {
      const text = await answerFn({ contract: c, sources, question, risk, signal: ctrl.signal, onToken: (t) => send('token', { t }) });
      c.chatHistory.push({ role: 'user', content: question }, { role: 'assistant', content: text });
      c.chatHistory = c.chatHistory.slice(-10);
      send('done', { text });
    } catch (e) {
      if (!(e instanceof AppError)) console.error('[chat]', e);
      send('error', toErrorBody(e).error);
    }
    res.end();
  });

  app.get('/api/contracts/:id/report', (req, res, next) => {
    try {
      const c = need(req);
      if (!c.review) throw new AppError('NOT_REVIEWED', '合同尚未完成审查', 409);
      track('export', c.id);
      const name = `合同审查报告-${c.fileName.replace(/\.pdf$/i, '')}.html`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="report.html"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.send(renderReport(c));
    } catch (e) { next(e); }
  });

  app.post('/api/events', (req, res) => {
    const { name, contractId, props } = req.body || {};
    res.json({ ok: track(String(name || ''), contractId ? String(contractId).slice(0, 20) : null, props) });
  });
  app.get('/api/metrics', (req, res) => res.json(summary()));

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (!(err instanceof AppError)) console.error('[error]', err);
    res.status(err.status || 500).json(toErrorBody(err));
  });
  return app;
}
