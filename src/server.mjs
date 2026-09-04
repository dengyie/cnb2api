// http server + 路由
import http from 'node:http';
import { config } from './config.mjs';
import { checkAuth } from './auth.mjs';
import { forward } from './proxy.mjs';
import { log, newReqId } from './log.mjs';

function send(res, status, body, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  res.writeHead(status, headers);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on('data', (c) => {
      if (oversized) return; // 超限后继续丢弃到达的数据，让 413 响应能干净送达
      size += c.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => {}); // reject 已发生/客户端断开，静默即可
  });
}

const server = http.createServer(async (req, res) => {
  const reqId = newReqId();
  const started = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.url === '/health') {
      return send(res, 200, { status: 'ok', uptime_sec: Math.round(process.uptime()), upstream_repo: config.repo });
    }

    if (req.url === '/v1/models' || req.url === '/models') {
      // 模型列表需要鉴权（key 不对同样计失败）；health 保持免鉴权供探测
      const auth = checkAuth(req);
      if (!auth.ok) {
        log.warn(reqId, 'auth failed', { status: auth.status, path: req.url });
        const h = auth.retryAfterSec ? { 'Retry-After': String(auth.retryAfterSec) } : {};
        return send(res, auth.status, auth.body, h);
      }
      return send(res, 200, { object: 'list', data: config.models.map((id) => ({ id, object: 'model', owned_by: 'cnb' })) });
    }

    if (req.method === 'POST' && req.url.split('?')[0].endsWith('/chat/completions')) {
      const auth = checkAuth(req);
      if (!auth.ok) {
        log.warn(reqId, 'auth failed', { status: auth.status });
        const h = auth.retryAfterSec ? { 'Retry-After': String(auth.retryAfterSec) } : {};
        return send(res, auth.status, auth.body, h);
      }

      let raw;
      try {
        raw = await readBody(req, config.maxBodyBytes);
      } catch (e) {
        if (e.code === 413) return send(res, 413, { error: { message: 'request body exceeds limit', type: 'invalid_request_error' } });
        throw e;
      }
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        return send(res, 400, { error: { message: 'request body is not valid JSON', type: 'invalid_request_error' } });
      }
      const wantStream = parsed.stream === true;

      const out = await forward({ reqId, payload: parsed, wantStream, res });
      if (out.handled) return; // 流式：proxy.mjs 已写完响应
      return send(res, out.status, out.body);
    }

    return send(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    log.error(reqId, 'handler crash', { err: String(e).slice(0, 300) });
    return send(res, 500, { error: { message: 'internal error' } });
  } finally {
    log.info(reqId, 'request', { method: req.method, path: req.url, ms: Date.now() - started });
  }
});

server.listen(config.port, '0.0.0.0', () => {
  log.info('-', 'listening', { port: config.port, upstream: config.upstreamUrl, models: config.models });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log.info('-', `got ${sig}, closing`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
