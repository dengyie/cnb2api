// 上游转发：超时 + 双向取消（客户端断开 → abort 上游，停止空读烧额度）
import { config } from './config.mjs';
import { log } from './log.mjs';
import { aggregate } from './sse.mjs';
import { record as recordUsage } from './usage.mjs';
import { observe as observeModel } from './models.mjs';

// 出站请求剥除思考开关：带 reasoning_effort 等思考参数时上游路由到 thinking 变体，
// 而该变体把推理阶段也计入 max_tokens——推理吃满预算后 finish_reason=length、
// content 全空（答案永不生成，真机实测 2048/8192 token 必现）。上游无正确开关可配，
// 出站统一剥除、锁定非 thinking 变体（与 /v1/messages 请求侧丢弃 thinking 块同一策略）。
// 表驱动：上游若引入新的思考开关命名，往这张表加一项即可。
//
// 逃生口：剥除是"安全默认值"，不是"唯一正确策略"。它把客户端永久锁死在非 thinking
// 变体上，思考能力整体消失——2026-10-08 同步本提交后，某下游的 CNB 侧 reasoning 从
// 每天数百万字符直接归零，且试遍参数拼写（reasoningEffort / enableThinking /
// chat_template_kwargs / extra_body / thinking_budget）都无法再触达 thinking 变体。
// 会翻车的组合其实只是"思考开关 + 过小的 max_tokens"；max_tokens 给够时推理与正文会
// 依次产出（2026-09-18/09-20 真实流量在 max_tokens=60000 下完全正常）。
// 因此：默认仍剥除，工作区显式设 CNB2API_ALLOW_THINKING=1 时放行，由客户端自负预算。
const REASONING_TRIGGERS = ['reasoning_effort', 'reasoning', 'enable_thinking', 'thinking'];

function stripReasoningTriggers(payload) {
  if (config.allowThinking) return payload;
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

  const timer = setTimeout(abortUpstream, config.upstreamTimeoutMs);
  let up;
  try {
    up = await fetch(config.upstreamUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.upstreamToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...stripReasoningTriggers(payload), stream: true }),
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
