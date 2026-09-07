// http server + 路由
import http from 'node:http';
import { config } from './config.mjs';
import { checkAuth } from './auth.mjs';
import { forward } from './proxy.mjs';
import { log, newReqId } from './log.mjs';
import { snapshot as usageSnapshot } from './usage.mjs';
import { fromAnthropicRequest, toAnthropicResponse, AnthropicStream, countTokensEstimate, frame, ProtocolError } from './anthropic.mjs';

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

// 鉴权失败统一出口（带失败计数限速 + Retry-After）
function sendAuthFailure(res, auth, reqId, path) {
  log.warn(reqId, 'auth failed', { status: auth.status, path });
  const h = auth.retryAfterSec ? { 'Retry-After': String(auth.retryAfterSec) } : {};
  return send(res, auth.status, auth.body, h);
}

// OpenAI 形态错误体 → Anthropic error envelope（/v1/messages 专用；上游透传体只有 error.message 可靠）
function anthropicError(status, body) {
  const message = body?.error?.message || `upstream error (HTTP ${status})`;
  const type = status === 401 || status === 403 ? 'authentication_error'
    : status === 429 ? 'rate_limit_error'
    : status >= 500 ? 'api_error'
    : 'invalid_request_error';
  return { type: 'error', error: { type, message } };
}

// 读请求体并校验 JSON；失败时已写响应并返回 null。envelope=true 时错误包 Anthropic 形态
async function readJsonBody(req, res, reqId, { envelope = false } = {}) {
  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (e) {
    if (e.code === 413) send(res, 413, envelope ? anthropicError(413, { error: { message: 'request body exceeds limit' } }) : { error: { message: 'request body exceeds limit', type: 'invalid_request_error' } });
    else throw e;
    return null;
  }
  try { return JSON.parse(raw); } catch {
    send(res, 400, envelope ? anthropicError(400, { error: { message: 'request body is not valid JSON' } }) : { error: { message: 'request body is not valid JSON', type: 'invalid_request_error' } });
    return null;
  }
}

async function handleChatCompletions(req, res, reqId) {
  const auth = checkAuth(req);
  if (!auth.ok) return sendAuthFailure(res, auth, reqId, req.url);

  const parsed = await readJsonBody(req, res, reqId);
  if (parsed === null) return;

  const wantStream = parsed.stream === true;
  const out = await forward({ reqId, payload: parsed, wantStream, res });
  if (out.handled) return; // 流式：proxy.mjs 已写完响应
  return send(res, out.status, out.body);
}

const server = http.createServer(async (req, res) => {
  const reqId = newReqId();
  const started = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.url === '/health') {
      // /health is unauthenticated by design (probing): it must leak nothing
      // about where the proxy lives — no repo identity here.
      return send(res, 200, { status: 'ok', uptime_sec: Math.round(process.uptime()) });
    }

    // token usage snapshot (auth required). Expose it for external sync/monitoring
    // if you want; totals are per-boot in-memory and reset on restart.
    if (req.url === '/usage') {
      const auth = checkAuth(req);
      if (!auth.ok) return sendAuthFailure(res, auth, reqId, req.url);
      return send(res, 200, usageSnapshot());
    }

    if (req.url === '/v1/models' || req.url === '/models') {
      // 模型列表需要鉴权（key 不对同样计失败）；health 保持免鉴权供探测
      const auth = checkAuth(req);
      if (!auth.ok) return sendAuthFailure(res, auth, reqId, req.url);
      return send(res, 200, { object: 'list', data: config.models.map((id) => ({ id, object: 'model', owned_by: 'cnb' })) });
    }

    if (req.method === 'POST' && req.url.split('?')[0].endsWith('/chat/completions')) {
      return handleChatCompletions(req, res, reqId);
    }

    // Anthropic Messages 协议（claude code 直连）：翻译成上游 OpenAI 端点
    if (req.method === 'POST' && req.url.split('?')[0].endsWith('/messages/count_tokens')) {
      const auth = checkAuth(req);
      if (!auth.ok) return sendAuthFailure(res, auth, reqId, req.url);
      const bodyRes = await readJsonBody(req, res, reqId, { envelope: true });
      if (!bodyRes) return; // 错误响应已写
      return send(res, 200, countTokensEstimate(bodyRes));
    }

    if (req.method === 'POST' && req.url.split('?')[0].endsWith('/messages')) {
      const auth = checkAuth(req);
      if (!auth.ok) return sendAuthFailure(res, auth, reqId, req.url);

      const anthropicBody = await readJsonBody(req, res, reqId, { envelope: true });
      if (!anthropicBody) return;
      const requestId = `${reqId}${Date.now().toString(36)}`;

      let openaiPayload;
      try {
        openaiPayload = fromAnthropicRequest(anthropicBody);
      } catch (e) {
        if (e instanceof ProtocolError) {
          return send(res, e.status, { type: 'error', error: { type: 'invalid_request_error', message: e.message } });
        }
        throw e;
      }
      const clientModel = anthropicBody.model || '';
      const wantStream = openaiPayload.stream === true;

      const transform = {
        // 流式：OpenAI chunk → Anthropic 事件
        stream: new AnthropicStream({ model: clientModel, requestId }),
        frame,
        // 非流式：OpenAI 聚合对象 → Messages
        response: (body) => toAnthropicResponse(body, { model: clientModel, requestId }),
      };

      const out = await forward({ reqId, payload: openaiPayload, wantStream, res, transform });
      if (out.handled) return; // 流式已写完
      // 非流式：成功 → Messages；上游错误 → 包 Anthropic error envelope
      if (out.status >= 400) return send(res, out.status, anthropicError(out.status, out.body));
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
