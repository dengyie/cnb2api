// 上游转发：超时 + 双向取消（客户端断开 → abort 上游，停止空读烧额度）
import { config } from './config.mjs';
import { log } from './log.mjs';
import { aggregate } from './sse.mjs';

export async function forward({ reqId, payload, wantStream, res }) {
  const started = Date.now();
  const ac = new AbortController();
  const abortUpstream = () => ac.abort();
  res.on('close', () => { if (!res.writableEnded) abortUpstream(); });

  const timer = setTimeout(abortUpstream, config.upstreamTimeoutMs);
  let up;
  try {
    up = await fetch(config.upstreamUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.upstreamToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return { handled: true, status: null }; // 客户端已走
    if (ac.signal.aborted) {
      log.warn(reqId, 'upstream connect timeout', { ms: config.upstreamTimeoutMs });
      return { handled: false, status: 504, body: { error: { message: 'upstream connect timeout' } } };
    }
    log.error(reqId, 'upstream fetch failed', { err: String(e).slice(0, 200) });
    return { handled: false, status: 502, body: { error: { message: `upstream connect failed: ${e.cause || e}` } } };
  }
  clearTimeout(timer);

  if (!up.ok) {
    const t = await up.text().catch(() => '');
    log.warn(reqId, 'upstream error', { status: up.status, preview: t.slice(0, 200) });
    return { handled: false, status: up.status, body: safeJsonOrText(t) };
  }

  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let idle;
    // 空闲看门狗：每个 chunk 重置；上游中途停滞超过 idleTimeoutMs → abort（连接超时之外的第二道保护）
    const readChunk = () => new Promise((resolve, reject) => {
      idle = setTimeout(() => reject(new Error('stream idle timeout')), config.idleTimeoutMs);
      reader.read().then(
        (r) => { clearTimeout(idle); resolve(r); },
        (e) => { clearTimeout(idle); reject(e); },
      );
    });
    try {
      for (;;) {
        if (res.destroyed || ac.signal.aborted) { await reader.cancel().catch(() => {}); break; }
        const { done, value } = await readChunk();
        if (done) break;
        if (!res.write(dec.decode(value))) {
          // 背压：drain 或 close 任一先到即放行（客户端断开时 close 才能解除挂起）
          await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
        }
      }
      if (!res.destroyed) res.end();
    } catch (e) {
      clearTimeout(idle);
      await reader.cancel().catch(() => {});
      ac.abort();
      if (!res.destroyed) res.end();
      log.warn(reqId, 'stream aborted', { err: String(e).slice(0, 120) });
    } finally {
      clearTimeout(idle);
    }
    log.info(reqId, 'stream done', { ms: Date.now() - started });
    return { handled: true, status: 200 };
  }

  // 非流式：聚合整个 SSE 流
  const idleTimer = setTimeout(abortUpstream, config.idleTimeoutMs);
  let text = '';
  try {
    text = await up.text();
  } catch (e) {
    clearTimeout(idleTimer);
    return { handled: false, status: 504, body: { error: { message: 'upstream stream timeout' } } };
  }
  clearTimeout(idleTimer);
  const body = aggregate(text);
  log.info(reqId, 'chat done', { ms: Date.now() - started, out: body.usage.completion_tokens });
  return { handled: false, status: 200, body };
}

function safeJsonOrText(t) {
  try { return JSON.parse(t); } catch { return { error: { message: t.slice(0, 500) || 'upstream error' } }; }
}
