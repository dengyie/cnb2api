// 测试：本地起 mock 上游，不打真实 CNB API
// 运行：node --test test/proxy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const MOCK_PORT = 19101;
const PROXY_PORT = 19102;
const KEY = 'test-key-12345';
// 嗅探注册表状态文件隔离到临时目录：避免污染仓库，也避免上次运行残留使 models 列表漂移
const STATE_PATH = join(tmpdir(), `cnb2api-models-test-${process.pid}.json`);

// ---- mock 上游：完整 SSE（usage/tool_calls/finish_reason）+ 可选慢响应 ----
const upstreamState = { clientAborted: false, lastBody: null };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    upstreamState.lastBody = parsed; // 捕获打向上游的出站请求体（剥除类断言用）

    if (parsed.model === 'mock-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock upstream boom' } }));
      return;
    }
    if (parsed.model === 'mock-hang') {
      // 连接后不回任何字节 → 代理应在上游连接超时后回 504（而不是挂死客户端）
      return;
    }
    if (parsed.model === 'mock-reset') {
      // 收到请求后直接断连 → 代理应回 502，且错误消息不泄漏内部异常细节
      res.socket.destroy();
      return;
    }
    if (parsed.model === 'mock-stall') {
      // 出响应头后停滞 → 代理流空闲看门狗应 abort 并结束响应
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      // 之后不再写、也不 end
      return;
    }
    if (parsed.model === 'mock-noeol') {
      // 末尾 usage chunk 不以换行结尾就直接 FIN（sseTail 残留边界：收尾 flush 才能提取到 usage）
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}');
      res.end(); // 注意：无 \n 结尾
      return;
    }
    if (parsed.model === 'mock-slow') {
      upstreamState.clientAborted = false;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const iv = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`), 50);
      // 注意：req 的 'close' 在请求体读完即触发（Node 18+），不能用于检测客户端断开；
      // res 'close' 才是 socket 级关闭事件 —— 只有代理 abort fetch 时才会发生
      res.on('close', () => { upstreamState.clientAborted = true; clearInterval(iv); });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { id: 'chatcmpl-mock', model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'he' } }] },
      { choices: [{ index: 0, delta: { content: 'llo' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_', arguments: '{"cit' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'y":"SF"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    chunks.forEach((c, i) => setTimeout(() => {
      res.write(`data: ${JSON.stringify(c)}\n\n`);
      if (i === chunks.length - 1) res.write('data: [DONE]\n\n');
    }, i * 10));
    setTimeout(() => res.end(), 100);
  });
});

async function waitPort(port, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    try { await fetch(`http://127.0.0.1:${port}/health`); return; } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`port ${port} not up`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function startProxy(env = {}) {
  return spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PROXY_PORT: String(PROXY_PORT), PROXY_KEY: KEY, CNB_REPO_SLUG: 'test/repo', CNB_TOKEN: 'test-token', UPSTREAM_OVERRIDE: `http://127.0.0.1:${MOCK_PORT}`, PROXY_UPSTREAM_TIMEOUT_MS: '400', PROXY_IDLE_TIMEOUT_MS: '400', PROXY_MODELS_STATE: STATE_PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// mock 上游地址需要可注入：server.mjs 读 UPSTREAM_OVERRIDE（测试专用）
let proxy;
let serverLog = ''; // 服务端 stdout 日志收集（请求级 reqId 串联，供悬挂回归断言）

test.before(async () => {
  rmSync(STATE_PATH, { force: true }); // 清掉同 PID 复用的残留，保证首个用例看到纯回退列表
  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  proxy = startProxy();
  proxy.stdout.on('data', (b) => (serverLog += b.toString()));
  await waitPort(PROXY_PORT);
});

test.after(() => {
  proxy?.kill('SIGTERM');
  mockServer.close();
});

async function chat(payload, headers = { Authorization: `Bearer ${KEY}` }) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return res;
}

test('health + models', async () => {
  const h = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  assert.equal(h.status, 200);
  const m = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const mj = await m.json();
  assert.equal(mj.object, 'list');
  // 尚无嗅探样本时回退 PROXY_MODELS（默认 3 个）
  assert.ok(mj.data.length >= 3, `expected fallback list, got ${JSON.stringify(mj.data)}`);
});

test('models: 响应嗅探真实上游模型名后 /v1/models 返回它', async () => {
  // 打一次非流式请求：mock 上游回显 model=mock-model → 注册表登记
  const r = await chat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], stream: false });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.model, 'mock-model');

  const m = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const mj = await m.json();
  const ids = mj.data.map((d) => d.id);
  assert.deepEqual(ids, ['mock-model'], 'once sniffed, only the real upstream model should be advertised');
});

test('models: 流式响应同样触发嗅探', async () => {
  // mock 流式回显 model=mock-model（见 mock 上游 chunks）；确保流式路径也接了 observe()
  const r = await chat({ model: 'deepseek-v4.1-flash', messages: [], stream: true });
  assert.equal(r.status, 200);
  await r.text(); // 读完整流
  const m = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const ids = (await m.json()).data.map((d) => d.id);
  assert.ok(ids.includes('mock-model'));
});

test('auth: 等字符串长度含非 ASCII 的头 → 401 不崩溃（回归：曾抛 timingSafeEqual RangeError 且路由 return 未 await，单请求打崩进程）', async () => {
  // expected="Bearer test-key-12345"（21 字符）；candidate 同 JS 长度但含 latin1 高位
  // 字节 → Buffer 字节长度不等 → timingSafeEqual 曾抛 RangeError，而 handleChatCompletions
  // 被 return（未 await）→ 异常成 unhandledRejection → 进程直接退出
  const cand = 'Bearer test-key-1234\u00C3';
  const r = await chat({ messages: [] }, { Authorization: cand });
  assert.equal(r.status, 401, 'must be 401, not a crash');
  // 进程存活：随后正常请求仍 200（不消耗限速窗口：此请求成功不计失败）
  const ok = await chat({ model: 'mock-model', messages: [], stream: false });
  assert.equal(ok.status, 200, 'proxy must survive the malformed auth header');
});

test('auth: wrong key 401, then rate limited 429', async () => {
  // models 也走鉴权：首个失败请求用 models 端点验证 401（阈值前）
  const mNoKey = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`);
  assert.ok([401, 429].includes(mNoKey.status));
  // 失败计数跨用例累积（60s 窗口），动态打到 429 为止：阈值前每次失败都应 401
  let hit429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await chat({ messages: [] }, { Authorization: 'Bearer wrong' });
    if (r.status === 429) { hit429 = true; break; }
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401 before threshold`);
  }
  assert.ok(hit429, 'wrong-key flood must hit 429 within the window');
});


test('aggregation: content + tool_calls + finish_reason + usage', async () => {
  const r = await chat({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: false });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, 'chat.completion');
  assert.equal(j.model, 'mock-model');
  assert.equal(j.choices[0].message.content, 'hello');
  assert.equal(j.choices[0].finish_reason, 'tool_calls');
  const tc = j.choices[0].message.tool_calls?.[0];
  assert.equal(tc?.id, 'call_1');
  assert.equal(tc?.function.name, 'get_');
  assert.equal(tc?.function.arguments, '{"city":"SF"}');
  assert.equal(j.usage.prompt_tokens, 10);
  assert.equal(j.usage.total_tokens, 15);
});

test('invalid json → 400', async () => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

test('body 未读完客户端断开 → 请求终结不悬挂（回归：曾永久挂起泄漏闭包、访问日志不落）', async () => {  // 客户端发大 body 后中途断连（读 body 阶段断开）：readBody 的 Promise 曾永不
  // settle → handler 悬挂、finally 的访问日志永不写。修复后断开即终结该请求。
  // 断开时它是唯一 in-flight 请求 → 其访问日志出现即证明未悬挂。
  const raw = net.connect(PROXY_PORT, '127.0.0.1');
  await new Promise((r) => raw.once('connect', r));
  const body = 'x'.repeat(1024 * 1024); // 1MiB > socket 缓冲，强制分多次写
  raw.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${KEY}\r\nContent-Type: application/json\r\nContent-Length: ${body.length + 10}\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 50)); // 等服务端进入读 body 阶段
  for (let off = 0; off < body.length && !raw.destroyed; off += 64 * 1024) {
    raw.write(body.slice(off, Math.min(off + 64 * 1024, body.length)));
    await new Promise((r) => setTimeout(r, 10));
  }
  const logsBefore = serverLog.split('"msg":"request"').length - 1;
  raw.destroy(); // 少发 10 字节即断 → 服务端读 body 阶段遭遇客户端断开
  // 修复后该请求的 finally 访问日志应在数百 ms 内落盘；悬挂则永不出现
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (serverLog.split('"msg":"request"').length - 1 > logsBefore) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('aborted mid-body request must terminate and log, not hang forever');
});

test('合法 JSON 但非对象 → 400 可解析（回归：null 体曾静默挂死、原始类型曾 TypeError 劣化 502）', async () => {
  // 两个历史缺陷同一根因（入口无形状校验）：
  // ① body=null 曾直接 return 不回包 → 客户端挂死到自身超时；
  // ② body=123/"str" 曾在 stripReasoningTriggers 的 in 操作符上抛 TypeError → 误导性 502 计入 errors 看板
  for (const body of ['null', '123', '"str"', '[1,2]']) {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(res.status, 400, `body=${body} must be 400`);
    const j = await res.json(); // 可解析 = 响应确实写出了（挂死回归即在此断言失败）
    assert.equal(j.error.type, 'invalid_request_error');
  }
  // /v1/messages 同样兜住，且包 Anthropic envelope
  const m = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(m.status, 400);
  const mj = await m.json();
  assert.equal(mj.type, 'error');
  assert.equal(mj.error.type, 'invalid_request_error');
});

test('body over 4MiB → 413', async () => {
  const big = JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(5 * 1024 * 1024) }] });
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: big,
  });
  assert.equal(res.status, 413);
});

test('stream passthrough: SSE bytes flow to client', async () => {
  const r = await chat({ model: 'mock-model', messages: [], stream: true });
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-type') || '').includes('text/event-stream'));
  const text = await r.text();
  assert.ok(text.includes('"content":"he"'));
  assert.ok(text.includes('[DONE]'));
});

test('upstream 500 → transparent pass-through', async () => {
  const r = await chat({ model: 'mock-500', messages: [] });
  assert.equal(r.status, 500);
  const j = await r.json();
  assert.equal(j.error.message, 'mock upstream boom');
});

test('upstream 断连 → 502 且消息不外泄内部异常细节', async () => {
  // mock-reset 直接触发 fetch 异常（非超时路径）：错误详情只进日志，客户端消息固定
  const r = await chat({ model: 'mock-reset', messages: [] });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error.message, 'upstream connect failed');
});

test('client abort cancels upstream (stop burning tokens)', async () => {
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-slow', messages: [], stream: true }),
    signal: ac.signal,
  });
  assert.equal(r.status, 200);
  await r.body.cancel(); // 客户端中途断开
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(upstreamState.clientAborted, true, 'mock upstream should observe client disconnect');
});

test('upstream connect timeout → 504 (not hang)', async () => {
  const t0 = Date.now();
  const r = await chat({ model: 'mock-hang', messages: [] });
  assert.equal(r.status, 504);
  assert.ok(Date.now() - t0 < 3000, 'should fail fast, not hang');
});

test('stream stall → idle watchdog ends response', async () => {
  const r = await chat({ model: 'mock-stall', messages: [], stream: true });
  assert.equal(r.status, 200);
  const t0 = Date.now();
  const text = await r.text(); // 停滞超时后服务端 end，客户端能读完整流
  assert.ok(Date.now() - t0 < 3000, 'stalled stream should be closed by watchdog');
  assert.ok(text.includes('first'));
});

test('unknown path → 404', async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/nope`);
  assert.equal(r.status, 404);
});

test('usage endpoint: stream + non-stream both counted', async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/usage`, { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.boot_id, 'boot_id present');
  // 前面的聚合用例（非流式）+ 流式用例都打了带 usage {10,5} 的 mock 上游
  assert.ok(j.totals.prompt >= 20, `prompt should accumulate, got ${j.totals.prompt}`);
  assert.ok(j.totals.completion >= 10, `completion should accumulate, got ${j.totals.completion}`);
});

test('usage endpoint requires auth', async () => {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/usage`);
  // 401=未授权；若 auth 测试已触发 60s 限速窗口则返回 429，两者均为拒绝
  assert.ok([401, 429].includes(r.status), `expected 401/429, got ${r.status}`);
});

async function usageTotals() {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/usage`, { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(r.status, 200);
  return (await r.json()).totals;
}

test('errors 计数口径：上游故障计 error，客户端取消不计', async () => {
  // ① 上游 HTTP 500（透传路径）→ errors +1
  const before500 = (await usageTotals()).errors;
  await chat({ model: 'mock-500', messages: [] });
  assert.equal((await usageTotals()).errors, before500 + 1, 'upstream 500 must count as error');

  // ② 上游连接超时（504 路径）→ errors +1
  const before504 = (await usageTotals()).errors;
  await chat({ model: 'mock-hang', messages: [] });
  assert.equal((await usageTotals()).errors, before504 + 1, 'upstream connect timeout must count as error');

  // ③ 客户端中途取消流（正常行为）→ errors 不变
  const beforeAbort = (await usageTotals()).errors;
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-slow', messages: [], stream: true }),
    signal: ac.signal,
  });
  assert.equal(r.status, 200);
  await r.body.cancel();
  await new Promise((res) => setTimeout(res, 300));
  assert.equal((await usageTotals()).errors, beforeAbort, 'client abort must NOT count as error');
});

test('sseTail 收尾 flush：末 chunk 无换行结尾仍提取 usage', async () => {
  const before = await usageTotals();
  const r = await chat({ model: 'mock-noeol', messages: [], stream: true });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('"content":"hi"'));
  const after = await usageTotals();
  // mock-noeol 上游 usage {7,3}：若收尾 flush 缺失，prompt 不增
  assert.ok(after.prompt >= before.prompt + 7, `prompt must include tail-flushed usage, before=${before.prompt} after=${after.prompt}`);
  assert.ok(after.completion >= before.completion + 3, 'completion must include tail-flushed usage');
});

test('reasoning_effort 出站剥除（真机教训：触发上游 thinking 变体后推理耗尽 max_tokens，content 永不产出）', async () => {
  // 上游退化形态实测（2026-10-04 生产抓帧）：带 reasoning_effort 的请求命中
  // thinking 变体 → 全部输出进 reasoning_content、content=[]、finish_reason=length，
  // 客户端收到的是"思考块"而非答案。上游网关无正确开关可配，出站统一剥除最稳。
  const r = await chat({
    model: 'mock-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    reasoning_effort: 'medium',
  });
  assert.equal(r.status, 200);
  await r.json();
  assert.equal(upstreamState.lastBody.reasoning_effort, undefined, 'reasoning_effort must be stripped from the upstream request');
  // 客户端侧原始参数不受影响是天然成立（我们只改出站体）；这里同时断言其他字段原样透传
  assert.equal(upstreamState.lastBody.model, 'mock-model');
  assert.equal(upstreamState.lastBody.temperature, undefined);

  // reasoning_content 响应参数（OpenAI o1 风格 reasoning: {effort}）同理剥除
  await chat({ model: 'mock-model', messages: [], stream: false, reasoning: { effort: 'high' } });
  assert.equal(upstreamState.lastBody.reasoning, undefined, 'reasoning object must be stripped too');
  // enable_thinking / thinking（部分网关的思考开关命名）同样不外泄
  await chat({ model: 'mock-model', messages: [], stream: false, enable_thinking: true, thinking: { type: 'enabled' } });
  assert.equal(upstreamState.lastBody.enable_thinking, undefined);
  assert.equal(upstreamState.lastBody.thinking, undefined);

  // 流式路径同一剥除（真实 CPA 渠道链走的是流式）：共享同一 fetch 出站点，
  // 断言钉住流式分支防未来重构把剥除挪进分支
  await chat({ model: 'mock-model', messages: [], stream: true, reasoning_effort: 'high' });
  assert.equal(upstreamState.lastBody.reasoning_effort, undefined, 'streaming path must strip too');
  assert.equal(upstreamState.lastBody.stream, true);
});

test('超时环境变量非法值 → 启动即拒（fail-fast，回归：NaN 曾使 setTimeout 按 0ms 触发、每条流瞬间 abort）', async () => {
  const bad = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PROXY_PORT: String(PROXY_PORT + 1), PROXY_KEY: KEY, CNB_REPO_SLUG: 'test/repo', CNB_TOKEN: 'test-token', UPSTREAM_OVERRIDE: `http://127.0.0.1:${MOCK_PORT}`, PROXY_IDLE_TIMEOUT_MS: 'abc' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise((r) => bad.on('exit', (c) => r(c)));
  assert.equal(code, 1, 'must refuse to start with a non-numeric timeout');
});

// ---------------------------------------------------------------------------
// 逃生口：CNB2API_ALLOW_THINKING=1 时放行思考开关
// 独立起一个进程（配置在启动时读取），用独立端口避免与主实例冲突
// ---------------------------------------------------------------------------
test('CNB2API_ALLOW_THINKING=1 → 思考开关透传到上游（逃生口）', async () => {
  const OPTIN_PORT = PROXY_PORT + 2;
  const optIn = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PROXY_PORT: String(OPTIN_PORT), PROXY_KEY: KEY, CNB_REPO_SLUG: 'test/repo',
      CNB_TOKEN: 'test-token', UPSTREAM_OVERRIDE: `http://127.0.0.1:${MOCK_PORT}`,
      PROXY_MODELS_STATE: join(tmpdir(), `cnb2api-optin-${process.pid}.json`),
      CNB2API_ALLOW_THINKING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitPort(OPTIN_PORT);
    const r = await fetch(`http://127.0.0.1:${OPTIN_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        max_tokens: 60000,
        reasoning_effort: 'high',
        thinking: { type: 'enabled' },
      }),
    });
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(upstreamState.lastBody.reasoning_effort, 'high', 'opt-in must forward reasoning_effort');
    assert.deepEqual(upstreamState.lastBody.thinking, { type: 'enabled' }, 'opt-in must forward thinking');
    // 非思考字段仍原样透传
    assert.equal(upstreamState.lastBody.model, 'mock-model');
    assert.equal(upstreamState.lastBody.max_tokens, 60000);
  } finally {
    optIn.kill('SIGTERM');
  }
});
