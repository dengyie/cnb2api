// Anthropic /v1/messages 适配测试：纯函数单测 + 本地起代理打 mock 上游的 E2E
// 运行：node --test test/anthropic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { fromAnthropicRequest, toAnthropicResponse, AnthropicStream, countTokensEstimate, frame, ProtocolError } from '../src/anthropic.mjs';

// ---------------------------------------------------------------------------
// 请求转换
// ---------------------------------------------------------------------------

test('请求转换：system/messages 基本映射', () => {
  const out = fromAnthropicRequest({
    model: 'claude-sonnet-4-5',
    max_tokens: 100,
    stream: true,
    system: 'be brief',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: 'bye' }] },
    ],
  });
  assert.equal(out.model, 'claude-sonnet-4-5');
  assert.equal(out.stream, true);
  assert.equal(out.max_tokens, 100);
  assert.deepEqual(out.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'bye' },
  ]);
});

test('请求转换：assistant tool_use → tool_calls，user tool_result → role:tool', () => {
  const out = fromAnthropicRequest({
    max_tokens: 100,
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny 20C' }] },
    ],
  });
  assert.equal(out.tools[0].function.name, 'get_weather');
  assert.deepEqual(out.messages[1].tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }]);
  assert.deepEqual(out.messages[2], { role: 'tool', tool_call_id: 'toolu_1', content: 'sunny 20C' });
});

test('请求转换：thinking 块丢弃、image 占位、stop_sequences/temperature 透传', () => {
  const out = fromAnthropicRequest({
    max_tokens: 50,
    temperature: 0.2,
    top_p: 0.9,
    stop_sequences: ['END'],
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what?' }] },
    ],
  });
  assert.equal(out.temperature, 0.2);
  assert.equal(out.top_p, 0.9);
  assert.deepEqual(out.stop, ['END']);
  assert.equal(out.messages[0].content, 'ok'); // thinking 不进 OpenAI
  assert.match(out.messages[1].content, /^\[image: data:image\/png;base64,<4 base64 chars>\]\n?what\?$/);
});

test('请求转换：被上游拦的短语出站前改写为等价表述', () => {
  const out = fromAnthropicRequest({
    max_tokens: 50,
    system: "x-anthropic-billing-header: cc_version=2.1.212.3f4; cc_entrypoint=sdk-cli;\nYou are Claude Code, Anthropic's official CLI for Claude.\nTo give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    messages: [
      { role: 'user', content: 'seen: To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues' },
      { role: 'assistant', content: [{ type: 'text', text: "TO GIVE FEEDBACK, USERS SHOULD REPORT THE ISSUE AT HTTPS://GITHUB.COM/ANTHROPICS/CLAUDE-CODE/ISSUES" }] },
    ],
  });
  const all = out.messages.map((m) => m.content).join('\n');
  assert.ok(!/x-anthropic-billing-header/i.test(all), 'billing header token must be replaced');
  assert.ok(!/to give feedback/i.test(all), 'blocked phrase must be rewritten');
  assert.ok(!/official cli for claude/i.test(all), 'identity sentence must be rewritten');
  assert.ok(/cc_version=2\.1\.212\.3f4; cc_entrypoint=sdk-cli;/.test(out.messages[0].content), 'billing values preserved');
  assert.ok(/share feedback, users can report the issue at https:\/\/github\.com\/anthropics\/claude-code\/issues/.test(out.messages[0].content), 'URL preserved');
  assert.match(out.messages[0].content, /a command-line coding assistant\./);
  // 无匹配短语的正常文本原样通过
  const plain = fromAnthropicRequest({ max_tokens: 10, messages: [{ role: 'user', content: 'hello world' }] });
  assert.equal(plain.messages[0].content, 'hello world');
});

test('请求转换：assistant tool_use arguments 同样改写，tool_choice 缺 name 报 400', () => {
  const out = fromAnthropicRequest({
    max_tokens: 50,
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file: 'f', content: 'see https://github.com/anthropics/claude-code/issues' } }] },
    ],
  });
  assert.ok(!/to give feedback/i.test(out.messages[1].tool_calls[0].function.arguments), 'tool arguments must be rewritten');
  assert.ok(/github\.com\/anthropics\/claude-code\/issues/.test(out.messages[1].tool_calls[0].function.arguments), 'URL preserved');
  assert.throws(
    () => fromAnthropicRequest({ max_tokens: 10, tools: [{ name: 'x', input_schema: {} }], tool_choice: { type: 'tool' }, messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e instanceof ProtocolError && e.status === 400,
  );
});

test('流式：abort() 收尾闭合所有块并以 message_stop 结束', () => {
  const s = new AnthropicStream({ requestId: 'ra' });
  const raw = [
    ...s.feed({ choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' } }] }),
    ...s.feed({ choices: [{ index: 0, delta: { content: '…' } }] }),
    ...s.abort(),
  ];
  const names = raw.map((e) => e.event);
  // 未闭合的 text 块必须先 content_block_stop，再收尾两事件；序列中不允许重复 stop
  assert.deepEqual(names.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(names.filter((n) => n === 'message_stop').length, 1);
  assert.equal(names.filter((n) => n === 'content_block_stop').length, 1);
  // abort 后再 feed/end 不产出任何事件（幂等收尾）
  assert.deepEqual(s.feed({ choices: [{ delta: { content: 'x' } }] }), []);
  assert.deepEqual(s.end(), []);
});

test('流式：上游空流（200 零 data 事件）收尾仍发出完整 message_start…message_stop', () => {
  const s = new AnthropicStream({ requestId: 're' });
  const raw = s.end();
  const names = raw.map((e) => e.event);
  // 空流也必须有完整收尾：message_start、ping 打头，message_delta + message_stop 必达且各一次
  assert.deepEqual(names, ['message_start', 'ping', 'message_delta', 'message_stop']);
  const delta = JSON.parse(raw[2].data);
  assert.equal(delta.delta.stop_reason, 'end_turn');
  // 收尾后状态机闭合：再 feed/end 不产出事件
  assert.deepEqual(s.feed({ choices: [{ delta: { content: 'x' } }] }), []);
  assert.deepEqual(s.end(), []);
});

test('请求转换：tool_result 对象形态 content 降级为 JSON 字符串（非 [object Object]）', () => {
  const out = fromAnthropicRequest({
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 't1',
        content: { stdout: 'ok', code: 0 },
      }],
    }],
  });
  assert.equal(out.messages[0].content, '{"stdout":"ok","code":0}');
});

test('请求转换：messages 内 system 角色按序透传（真机 claude code 会话实测场景）', () => {
  const out = fromAnthropicRequest({
    max_tokens: 50,
    system: 'top-level',
    messages: [
      { role: 'system', content: 'inline system' },
      { role: 'user', content: 'hi' },
    ],
  });
  // 顶级 system 在前，内联 system 保持原位透传，上游按序消费
  assert.deepEqual(out.messages, [
    { role: 'system', content: 'top-level' },
    { role: 'system', content: 'inline system' },
    { role: 'user', content: 'hi' },
  ]);
});

test('请求转换：非法输入抛 ProtocolError（status 400）', () => {
  assert.throws(() => fromAnthropicRequest({ messages: [] }), ProtocolError);
  assert.throws(() => fromAnthropicRequest({ messages: [{ role: 'tool', content: 'x' }] }), ProtocolError);
  assert.throws(() => fromAnthropicRequest({ messages: [{ role: 'user', content: 42 }] }), ProtocolError);
  const e = (() => { try { fromAnthropicRequest({ messages: [] }); } catch (err) { return err; } })();
  assert.equal(e.status, 400);
});

test('宽容校验：真机客户端的规范外载荷不 400（system role 教训的同类残留回归）', () => {
  // max_tokens: null（OpenAI 风格"不限制"）→ 兜底默认值
  const nullMt = fromAnthropicRequest({ max_tokens: null, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(nullMt.max_tokens, 4096);
  // content 缺失/null 的占位消息 → 空字符串
  const nullContent = fromAnthropicRequest({ max_tokens: 10, messages: [{ role: 'user' }, { role: 'assistant', content: null }, { role: 'user', content: 'go' }] });
  assert.deepEqual(nullContent.messages[0], { role: 'user', content: '' });
  assert.deepEqual(nullContent.messages[1], { role: 'assistant', content: '' });
  // 工具缺 input_schema（OpenAI 风格 function 体直塞）→ 空 schema 兜底
  const noSchema = fromAnthropicRequest({ max_tokens: 10, tools: [{ name: 'ping' }], messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(noSchema.tools, [{ type: 'function', function: { name: 'ping', description: '', parameters: { type: 'object' } } }]);
  // 未知块类型 → 占位符保序（Anthropic 前向兼容哲学），不再 400
  const unknownBlock = fromAnthropicRequest({ max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'search_result', source: 'x' }, { type: 'text', text: 'end' }] }] });
  assert.equal(unknownBlock.messages[0].content, '[search_result block]end');
  // 残缺 image source → 占位符，不再 400
  const badImage = fromAnthropicRequest({ max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'go' }] }] });
  assert.equal(badImage.messages[0].content, '[image: unsupported source]go');
});

// ---------------------------------------------------------------------------
// 非流式响应转换
// ---------------------------------------------------------------------------

test('响应转换：content/tool_use/stop_reason/usage 字段映射', () => {
  const openai = {
    model: 'deepseek-v4-flash',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
  };
  const out = toAnthropicResponse(openai, { model: 'claude-sonnet-4-5', requestId: 'abc' });
  assert.equal(out.type, 'message');
  assert.equal(out.id, 'msg_abc');
  assert.equal(out.role, 'assistant');
  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.content, [
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
  ]);
  assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 34 });
});

test('响应转换：stop_reason 映射 length→max_tokens、stop→end_turn、空 content 兜底', () => {
  const mk = (finish) => toAnthropicResponse({ choices: [{ message: { content: '' }, finish_reason: finish }], usage: {} }, { requestId: 'x' });
  assert.equal(mk('length').stop_reason, 'max_tokens');
  assert.equal(mk('stop').stop_reason, 'end_turn');
  assert.equal(mk(undefined).stop_reason, 'end_turn');
  assert.deepEqual(mk('stop').content, [{ type: 'text', text: '' }]);
});

// ---------------------------------------------------------------------------
// 流式状态机
// ---------------------------------------------------------------------------

function collect(stream, chunks) {
  const events = [];
  for (const c of chunks) events.push(...stream.feed(c).map((e) => `${e.event} ${e.data}`));
  events.push(...stream.end().map((e) => `${e.event} ${e.data}`));
  return events;
}

test('流式：完整事件序列 message_start→text 块→message_delta→message_stop', () => {
  const s = new AnthropicStream({ model: 'claude-sonnet-4-5', requestId: 'r1' });
  const events = collect(s, [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'he' } }] },
    { choices: [{ index: 0, delta: { content: 'llo' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
  ]);
  const names = events.map((e) => e.split(' ')[0]);
  assert.deepEqual(names, ['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  // 块索引一致
  const startIdx = JSON.parse(events[2].split(' ')[1]).index;
  for (const e of events.slice(3, 6)) assert.equal(JSON.parse(e.split(' ')[1]).index, startIdx);
  const delta = JSON.parse(events.find((e) => e.startsWith('content_block_delta') && e.includes('text_delta')).split(' ')[1]);
  assert.deepEqual(delta.delta, { type: 'text_delta', text: 'he' });
  const md = JSON.parse(events.find((e) => e.startsWith('message_delta')).split(' ')[1]);
  assert.equal(md.delta.stop_reason, 'end_turn');
  assert.equal(md.usage.output_tokens, 2);
});

test('流式：tool_calls 增量 → input_json_delta 拼装闭合', () => {
  const s = new AnthropicStream({ requestId: 'r2' });
  const events = collect(s, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_', arguments: '{"cit' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'y":"SF"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const toolStart = JSON.parse(events.find((e) => e.includes('"content_block":{"type":"tool_use"') || e.includes('"content_block": {"type":"tool_use"') || /content_block_start .*"tool_use"/.test(e)).split(' ').slice(1).join(' '));
  assert.equal(toolStart.content_block.name, 'get_');
  const jsonArg = events.filter((e) => e.startsWith('content_block_delta'))
    .map((e) => JSON.parse(e.split(' ').slice(1).join(' ')))
    .filter((d) => d.delta.type === 'input_json_delta')
    .map((d) => d.delta.partial_json).join('');
  assert.equal(jsonArg, '{"city":"SF"}');
  const md = JSON.parse(events.find((e) => e.startsWith('message_delta')).split(' ').slice(1).join(' '));
  assert.equal(md.delta.stop_reason, 'tool_use');
});

test('流式：usage 块输出 input_tokens（message_delta.output_tokens 来自末 chunk usage）', () => {
  const s = new AnthropicStream({ requestId: 'r3' });
  collect(s, [{ choices: [{ delta: { content: 'x' } }] }, { usage: { prompt_tokens: 100, completion_tokens: 7 } }]);
  // end() 后 usage 已在 message_delta
});

test('流式：frame() 产出合法 SSE 帧', () => {
  const f = frame({ event: 'ping', data: '{"type":"ping"}' });
  assert.equal(f, 'event: ping\ndata: {"type":"ping"}\n\n');
});

test('count_tokens：非空文本估算、空输入为 0', () => {
  assert.ok(countTokensEstimate({ messages: [{ role: 'user', content: 'a'.repeat(400) }] }).input_tokens >= 90);
  assert.equal(countTokensEstimate({ messages: [] }).input_tokens, 0);
});

// ---------------------------------------------------------------------------
// E2E：本地代理 + mock 上游（覆盖路由/鉴权头/流式事件流/非流式/错误透传）
// ---------------------------------------------------------------------------

const MOCK_PORT = 19121;
const PROXY_PORT = 19122;
const KEY = 'test-key-12345';

const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    // 断言：打到上游的一定是 OpenAI 格式（翻译正确性）
    assert.ok(Array.isArray(parsed.messages));
    assert.equal(parsed.stream, true);
    if (parsed.messages[0]?.role === 'system') assert.equal(parsed.messages[0].content, 'sys');

    if (parsed.model === 'mock-err') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
      return;
    }
    if (parsed.model === 'mock-empty') {
      // 200 但 SSE 体零 data 事件（只有注释行）：空流收尾必须完整
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(': keep-alive\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { id: 'c1', model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'he' } }] },
      { choices: [{ index: 0, delta: { content: 'llo' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ];
    chunks.forEach((c, i) => setTimeout(() => {
      res.write(`data: ${JSON.stringify(c)}\n\n`);
      if (i === chunks.length - 1) res.write('data: [DONE]\n\n');
    }, i * 10));
    setTimeout(() => res.end(), 80);
  });
});

let proxy;

test.before(async () => {
  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
  proxy = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PROXY_KEY: KEY, CNB_REPO_SLUG: 'test/repo', CNB_TOKEN: 'test-token', UPSTREAM_OVERRIDE: `http://127.0.0.1:${MOCK_PORT}/upstream`, PROXY_PORT: String(PROXY_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  for (;;) {
    try { await fetch(`http://127.0.0.1:${PROXY_PORT}/health`); break; } catch {}
    if (Date.now() - t0 > 5000) throw new Error('proxy not up');
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.after(() => {
  proxy?.kill('SIGTERM');
  mockServer.close();
});

function postMessages(body, headers = {}) {
  return fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('E2E 非流式：/v1/messages 返回 Anthropic message 对象', async () => {
  const res = await postMessages({ model: 'claude-x', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': KEY });
  assert.equal(res.status, 200);
  const msg = await res.json();
  assert.equal(msg.type, 'message');
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[0].text, 'hello');
  assert.equal(msg.stop_reason, 'end_turn');
  assert.deepEqual(msg.usage, { input_tokens: 10, output_tokens: 2 });
});

test('E2E 流式：事件流可被顺序解析且以 message_stop 收尾', async () => {
  const res = await postMessages({ model: 'claude-x', max_tokens: 32, stream: true, system: 'sys', messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': KEY });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  const events = [...text.matchAll(/event: (.+)\ndata: (.+)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
  assert.ok(events.length >= 6);
  assert.equal(events[0].event, 'message_start');
  assert.equal(events.at(-1).event, 'message_stop');
  const textDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta');
  assert.equal(textDeltas.map((d) => d.data.delta.text).join(''), 'hello');
});

test('E2E 错误透传：上游 500 → 500 Anthropic error envelope', async () => {
  const res = await postMessages({ model: 'mock-err', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': KEY });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'api_error');
  assert.equal(body.error.message, 'boom');
});

test('E2E 空流：上游 200 零 data 事件 → 流式仍以 message_delta + message_stop 收尾', async () => {
  const res = await postMessages({ model: 'mock-empty', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': KEY });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = [...text.matchAll(/event: (.+)\ndata: (.+)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
  assert.deepEqual(events.map((e) => e.event), ['message_start', 'ping', 'message_delta', 'message_stop']);
  assert.equal(events[2].data.delta.stop_reason, 'end_turn');
});

test('E2E 413：超限请求体 → Anthropic error envelope', async () => {
  const big = 'x'.repeat(5 * 1024 * 1024);
  const res = await postMessages({ model: 'x', max_tokens: 8, messages: [{ role: 'user', content: big }] }, { 'x-api-key': KEY });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'invalid_request_error');
});

test('E2E 400：非 JSON 请求体 → Anthropic error envelope', async () => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: '{not-json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'invalid_request_error');
});

test('E2E 鉴权：x-api-key 错误 401 且 Authorization: Bearer 同样可用', async () => {
  const bad = await postMessages({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': 'wrong' });
  assert.equal(bad.status, 401);
  const ok = await postMessages({ model: 'x', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, { Authorization: `Bearer ${KEY}` });
  assert.equal(ok.status, 200);
});

test('E2E count_tokens：POST /v1/messages/count_tokens 返回估算', async () => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hello world' }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.input_tokens > 0);
});

test('E2E 请求校验：messages 缺失 → 400 Anthropic error envelope', async () => {
  const res = await postMessages({ model: 'x' }, { 'x-api-key': KEY });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'invalid_request_error');
});
