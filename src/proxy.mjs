// 上游转发：超时 + 双向取消（客户端断开 → abort 上游，停止空读烧额度）
import { config } from './config.mjs';
import { log } from './log.mjs';
import { aggregate } from './sse.mjs';
import { record as recordUsage } from './usage.mjs';

export async function forward({ reqId, payload, wantStream, res, transform }) {
  // transform（可选）：Anthropic /v1/messages 适配挂载点。
  //   payload   已是 OpenAI 格式（server.mjs 侧完成 Messages→OpenAI 转换）
  //   stream.feed(openChunkObj) 逐 chunk 转换，返回待写事件数组（[] = 无输出）
  //   stream.end()             上游流收尾，返回收尾事件数组
  //   response(body)           非流式聚合结果 → 客户端 body（由 server.mjs 写出）
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
    // res 已死 = 客户端先断开触发 abort（正常行为），请求未产生上游结果，不计 errors
    if (res.writableEnded || res.destroyed) return { handled: true, status: null };
    // res 仍活 = 纯上游侧连接故障（超时 or 拒绝），计入 errors：看板最该暴露的信号
    recordUsage({ errors: 1 });
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
    recordUsage({ errors: 1 }); // 上游 HTTP 错误（配额耗尽 402/网关 5xx 等）计入 errors
    return { handled: false, status: up.status, body: safeJsonOrText(t) };
  }

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(transform ? { 'X-Accel-Buffering': 'no' } : {}), // 转换路径逐事件写出，禁 nginx 缓冲
    });
    const writeEvents = (events) => {
      for (const e of events) {
        if (res.destroyed) return;
        // 事件量级小（每 chunk 数百字节），Node 流缓冲可吸收；
        // 读取节奏由上游网络窗口节流，无需显式 await drain
        res.write(transform.frame(e));
      }
    };
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let idle;
    let sseTail = '';      // 跨 chunk 的半行缓冲（SSE 行可能被 TCP 分包截断）
    let usage = null;      // 流式路径从尾部 chunk 提取 usage（OpenAI 约定：最后一个 data 带 usage）
    let ok = false;        // 流正常走完（未中途 abort/停滞）
    let clientGone = false; // 客户端主动断开（正常行为，与上游流故障区分：不计 errors）
    // 行处理：usage 提取（所有路径）+ 协议转换（挂 transform 时逐行喂流式状态机）
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch { return; /* 心跳/非 JSON 行忽略 */ }
      if (j.usage) usage = j.usage;
      if (transform) writeEvents(transform.stream.feed(j));
    };
    const parseLines = (lines) => {
      for (const line of lines) handleLine(line);
    };
    // SSE 解码 + 行切分（跨 chunk 半行缓冲在 sseTail）；value=null 时 flush：
    // 解码器残余 + sseTail 末行（无换行结尾的 usage chunk 靠这一步补解析）
    const decodeAndParse = (value) => {
      const text = sseTail + (value === null ? dec.decode() : dec.decode(value, { stream: true }));
      const lines = text.split('\n');
      sseTail = lines.pop() ?? '';
      parseLines(value === null ? [...lines, sseTail] : lines);
      if (value === null) sseTail = '';
    };
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
        if (res.destroyed || ac.signal.aborted) { clientGone = true; await reader.cancel().catch(() => {}); break; }
        const { done, value } = await readChunk();
        if (done) break;
        if (transform) {
          // 协议转换路径：不给客户端透传原始 OpenAI 字节，事件由 handleLine 产出
          // （事件量级小，Node 流缓冲可吸收；读取节奏由上游网络窗口节流，无需显式 drain）
          decodeAndParse(value);
        } else {
          // 透传路径：背压 drain 或 close 任一先到即放行（客户端断开时 close 才能解除挂起）
          if (!res.write(value)) {
            await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
          }
          decodeAndParse(value); // 解码仅用于 usage 提取 + 协议解析（stream:true 保多字节跨 chunk 不乱码）
        }
      }
      // 收尾 flush：末尾 usage chunk 若不以换行结尾（上游直接 FIN），残余在 sseTail 里，此处补解析
      decodeAndParse(null);
      if (transform) writeEvents(transform.stream.end());
      if (!res.destroyed) res.end();
      ok = true;
    } catch (e) {
      clearTimeout(idle);
      await reader.cancel().catch(() => {});
      ac.abort();
      // 中途断流归因：客户端先断（res 已死）→ 取消上游属正常止损；res 仍活 → 上游停滞/读失败（watchdog 或传输错误）
      if (res.destroyed || res.writableEnded) clientGone = true;
      if (transform) writeEvents(transform.stream.abort());
      if (!res.destroyed) res.end();
      log.warn(reqId, 'stream aborted', { err: String(e).slice(0, 120) });
    } finally {
      clearTimeout(idle);
    }
    recordUsage({
      prompt: usage?.prompt_tokens || 0,
      completion: usage?.completion_tokens || 0,
      // 客户端主动断开是正常行为，不算错误；只有上游流故障（stall/异常，ok 未置位且非 clientGone）才计
      errors: ok || clientGone ? 0 : 1,
    });
    log.info(reqId, 'stream done', { ms: Date.now() - started, usage: usage ? 'exact' : 'none' });
    return { handled: true, status: 200 };
  }

  // 非流式：聚合整个 SSE 流
  const idleTimer = setTimeout(abortUpstream, config.idleTimeoutMs);
  let text = '';
  try {
    text = await up.text();
  } catch (e) {
    clearTimeout(idleTimer);
    // res 已死 = 客户端先断导致的读取消（abort 上游止损），不计 errors
    if (!(res.writableEnded || res.destroyed)) recordUsage({ errors: 1 });
    return { handled: false, status: 504, body: { error: { message: 'upstream stream timeout' } } };
  }
  clearTimeout(idleTimer);
  const body = aggregate(text);
  recordUsage({ prompt: body.usage.prompt_tokens || 0, completion: body.usage.completion_tokens || 0 });
  log.info(reqId, 'chat done', { ms: Date.now() - started, out: body.usage.completion_tokens });
  if (transform) return { handled: false, status: 200, body: transform.response(body) };
  return { handled: false, status: 200, body };
}

function safeJsonOrText(t) {
  try { return JSON.parse(t); } catch { return { error: { message: t.slice(0, 500) || 'upstream error' } }; }
}
