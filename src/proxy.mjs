// 上游转发：超时 + 双向取消（客户端断开 → abort 上游，停止空读烧额度）
import { config } from './config.mjs';
import { log } from './log.mjs';
import { aggregate } from './sse.mjs';
import { record as recordUsage } from './usage.mjs';
import { observe as observeModel } from './models.mjs';
import { prepareOutbound, foldSystemIntoUser, obfuscateNonUser } from './neutralize.mjs';

// 出站请求剥除思考开关：带 reasoning_effort 等思考参数时上游路由到 thinking 变体，
// 而该变体把推理阶段也计入 max_tokens——推理吃满预算后 finish_reason=length、
// content 全空（答案永不生成，真机实测 2048/8192 token 必现）。上游无正确开关可配，
// 出站统一剥除、锁定非 thinking 变体（与 /v1/messages 请求侧丢弃 thinking 块同一策略）。
// 表驱动：上游若引入新的思考开关命名，往这张表加一项即可。
const REASONING_TRIGGERS = ['reasoning_effort', 'reasoning', 'enable_thinking', 'thinking'];

function stripReasoningTriggers(payload) {
  if (!REASONING_TRIGGERS.some((k) => k in payload)) return payload;
  const out = { ...payload };
  for (const k of REASONING_TRIGGERS) delete out[k];
  return out;
}

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

  // 出站中性化：两条协议栈（OpenAI 透传 / Anthropic 转换）在这里汇合，
  // 关键词风控与首条 system 形状的规避只做一次（见 neutralize.mjs）。
  const { payload: outbound, rewritten } = prepareOutbound(payload, {
    enabled: config.neutralize,
    aggressive: config.neutralizeAggressive,
    ensureSystem: config.ensureSystemFirst,
    syntheticSystem: config.syntheticSystem,
  });
  if (rewritten) log.info(reqId, 'outbound neutralized', { fields: rewritten });

  // 上游内容风控（HTTP 400 / 业务码 11128）是「客户端指纹」的模糊匹配：
  // 无法用关键词表穷举（同一段话拆开都不拦、合起来才拦），所以关键词改写之外
  // 再加两级兜底形态，按级重发同一份内容（见 neutralize.mjs 顶部说明）。
  // 被拦的请求不会产生任何生成结果，重发不重复计费；正常请求只走第一级。
  const attempts = [{ strategy: 'primary', body: outbound }];
  if (config.blockRetry && outbound && typeof outbound === 'object' && !Array.isArray(outbound)) {
    const folded = foldSystemIntoUser(outbound);
    if (folded !== outbound) attempts.push({ strategy: 'fold-system', body: folded });
    const obfuscated = obfuscateNonUser(folded);
    if (obfuscated !== folded) attempts.push({ strategy: 'obfuscate', body: obfuscated });
  }

  let up = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const { strategy, body } = attempts[i];
    const timer = setTimeout(abortUpstream, config.upstreamTimeoutMs);
    try {
      up = await fetch(config.upstreamUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.upstreamToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...stripReasoningTriggers(body), stream: true }),
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
      // 错误详情只进日志：内部异常串（含 cause/payload 片段）不外泄给客户端
      return { handled: false, status: 502, body: { error: { message: 'upstream connect failed' } } };
    }
    clearTimeout(timer);

    if (up.ok) {
      if (i > 0) log.warn(reqId, 'blocked retry recovered', { strategy, attempt: i + 1 });
      break;
    }

    // 客户端已经走了：错误体不必再读，也没有人可以接收重发结果
    if (res.destroyed || res.writableEnded) return { handled: true, status: null };

    const t = await up.text().catch(() => '');
    if (isBlocked11128(up.status, t) && i < attempts.length - 1) {
      log.warn(reqId, 'upstream blocked, retrying', { strategy, next: attempts[i + 1].strategy, status: up.status });
      continue;
    }
    log.warn(reqId, 'upstream error', { status: up.status, preview: t.slice(0, 200) });
    recordUsage({ errors: 1 }); // 上游 HTTP 错误（配额耗尽 402/网关 5xx/风控 11128 等）计入 errors
    return { handled: false, status: up.status, body: safeJsonOrText(t) };
  }

  // 兜底：循环内每个非 200 分支都已 return，这里只防御未来重构漏写分支。
  if (!up || !up.ok) return { handled: false, status: 502, body: { error: { message: 'upstream connect failed' } } };

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
      if (j.model) observeModel(j.model); // 嗅探上游真实模型名（无 list 接口，只能从响应读）
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
  if (body.model) observeModel(body.model); // 嗅探上游真实模型名（非流式聚合结果里的 model）
  recordUsage({ prompt: body.usage.prompt_tokens || 0, completion: body.usage.completion_tokens || 0 });
  log.info(reqId, 'chat done', { ms: Date.now() - started, out: body.usage.completion_tokens });
  if (transform) return { handled: false, status: 200, body: transform.response(body) };
  return { handled: false, status: 200, body };
}

function safeJsonOrText(t) {
  try { return JSON.parse(t); } catch { return { error: { message: t.slice(0, 500) || 'upstream error' } }; }
}

// 上游内容风控的固定形状：HTTP 400 + 业务码 11128（"Illegal API invocation from
// an unapproved channel"）。只认这一种，别的 400（参数错、多余字段…）不重试——
// 重试只会把同一个错误再打一遍上游。
// 业务码可能以数字或字符串出现，消息也可能只带 Illegal API invocation 字样；
// 三种都认，避免上游改一处序列化就让整条兜底失效。
export function isBlocked11128(status, text) {
  if (status !== 400) return false;
  const s = String(text || '');
  return /["']?code["']?\s*:\s*["']?11128(?=\D|$)/.test(s)
    || /unapproved channel/i.test(s)
    || /Illegal API invocation/i.test(s);
}
