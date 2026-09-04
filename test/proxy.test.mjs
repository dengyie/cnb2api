// 测试：本地起 mock 上游，不打真实 CNB API
// 运行：node --test test/proxy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const MOCK_PORT = 19101;
const PROXY_PORT = 19102;
const KEY = 'test-key-12345';

// ---- mock 上游：完整 SSE（usage/tool_calls/finish_reason）+ 可选慢响应 ----
const upstreamState = { clientAborted: false };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);

    if (parsed.model === 'mock-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock upstream boom' } }));
      return;
    }
    if (parsed.model === 'mock-hang') {
      // 连接后不回任何字节 → 代理应在上游连接超时后回 504（而不是挂死客户端）
      return;
    }
    if (parsed.model === 'mock-stall') {
      // 出响应头后停滞 → 代理流空闲看门狗应 abort 并结束响应
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      // 之后不再写、也不 end
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
    env: { ...process.env, PROXY_PORT: String(PROXY_PORT), PROXY_KEY: KEY, CNB_REPO_SLUG: 'test/repo', CNB_TOKEN: 'test-token', UPSTREAM_OVERRIDE: `http://127.0.0.1:${MOCK_PORT}`, PROXY_UPSTREAM_TIMEOUT_MS: '400', PROXY_IDLE_TIMEOUT_MS: '400', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// mock 上游地址需要可注入：server.mjs 读 UPSTREAM_OVERRIDE（测试专用）
let proxy;

test.before(async () => {
  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  proxy = startProxy();
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
  assert.ok(mj.data.length >= 3);
});

test('auth: wrong key 401, then rate limited 429', async () => {
  // models 也走鉴权：首个失败请求用 models 端点验证 401
  const mNoKey = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`);
  assert.equal(mNoKey.status, 401);
  for (let i = 0; i < 9; i++) {
    const r = await chat({ messages: [] }, { Authorization: 'Bearer wrong' });
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
  }
  const r = await chat({ messages: [] }, { Authorization: 'Bearer wrong' });
  assert.equal(r.status, 429);
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
