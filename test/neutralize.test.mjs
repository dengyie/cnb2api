// 出站中性化单测（纯函数，不起进程）
// 运行：node --test test/neutralize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  neutralize,
  prepareOutbound,
  normalizeRoles,
  ensureSystemFirst,
  foldSystemIntoUser,
  obfuscateNonUser,
  DEFAULT_SYSTEM_PROMPT,
} from '../src/neutralize.mjs';

const ZWSP = '\u200b';
const RAW_IDENTITY = /(?<![\\/])DeepSeek[ \u00A0]+Harness/i;

// ---------------------------------------------------------------------------
// 身份关键词
// ---------------------------------------------------------------------------

test('身份关键词：DeepSeek Harness 被打散，语义（去掉零宽后）不变', () => {
  const out = neutralize('You are an AI agent powered by DeepSeek Harness.');
  assert.ok(out.includes(`DeepSeek${ZWSP} Harness`), 'ZWSP must sit right after DeepSeek');
  assert.ok(!RAW_IDENTITY.test(out), 'raw identity phrase must no longer match');
  assert.equal(out.replaceAll(ZWSP, ''), 'You are an AI agent powered by DeepSeek Harness.');
});

test('身份关键词：大小写与 NBSP 变体同样命中', () => {
  for (const s of ['DEEPSEEK HARNESS', 'deepseek  harness', 'DeepSeek\u00A0Harness']) {
    const out = neutralize(s);
    assert.ok(out.includes(ZWSP), `must be neutralized: ${JSON.stringify(s)}`);
    assert.ok(!RAW_IDENTITY.test(out));
  }
});

test('身份关键词：路径语境（\\ 或 / 贴边）一律不改写，避免模型拿到坏路径', () => {
  const winPath = 'D:\\10_COD\\DeepSeek Harness\\resources\\app.asar\\dsh\\';
  const posixPath = '/opt/DeepSeek Harness/bin/tool';
  assert.equal(neutralize(winPath), winPath);
  assert.equal(neutralize(posixPath), posixPath);
  // 同一段文本里「路径」保留、「叙述」打散
  const mixed = `${winPath} runs inside DeepSeek Harness today`;
  const out = neutralize(mixed);
  assert.ok(out.startsWith(winPath), 'path prefix must be byte-identical');
  assert.ok(!out.slice(winPath.length).includes('DeepSeek Harness'));
});

test('身份关键词：幂等（二次中和不再变化）', () => {
  const once = neutralize('powered by DeepSeek Harness');
  assert.equal(neutralize(once), once);
});

test('客户端特征短语：Claude Code 计费头与两句身份/反馈语被等价改写', () => {
  const src = [
    'x-anthropic-billing-header: cc_version=2.1.212.3f4; cc_entrypoint=sdk-cli;',
    "You are Claude Code, Anthropic's official CLI for Claude.",
    'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
  ].join('\n');
  const out = neutralize(src);
  assert.ok(!/x-anthropic-billing-header/i.test(out));
  assert.ok(!/official cli for claude/i.test(out));
  assert.ok(!/to give feedback/i.test(out));
  // 值与原 URL 保留
  assert.ok(out.includes('cc_version=2.1.212.3f4; cc_entrypoint=sdk-cli;'));
  assert.ok(out.includes('https://github.com/anthropics/claude-code/issues'));
  // 普通文本原样通过
  assert.equal(neutralize('hello world'), 'hello world');
});

test('客户端特征短语：网关实测的客户端指纹（@ 路径 / Main branch）被等价改写', () => {
  const src = [
    'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.',
    'Main branch (you will usually use this for PRs)',
  ].join('\n');
  const out = neutralize(src);
  assert.ok(!/paths the user explicitly referenced/i.test(out));
  assert.ok(!/Relative paths resolve from the workspace root/i.test(out));
  assert.ok(!/you will usually use this for PRs/i.test(out));
  // 语义保留：路径语义仍然表达清楚
  assert.match(out, /path references the user made explicitly/);
  assert.match(out, /resolved against the workspace root/);
  // 幂等
  assert.equal(neutralize(out), out);
});

// ---------------------------------------------------------------------------
// 11128 兜底形态
// ---------------------------------------------------------------------------

test('兜底：foldSystemIntoUser 把 system 文本并进首条 user，指令不丢', () => {
  const payload = {
    model: 'm',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'again' },
    ],
  };
  const out = foldSystemIntoUser(payload);
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(out.messages[0].content, 'System instructions:\nbe terse\n\nhi');
  assert.equal(out.messages[1].content, 'yo', 'other messages untouched');
  assert.equal(payload.messages.length, 4, 'input payload must not be mutated');
});

test('兜底：foldSystemIntoUser 无 system 时原样返回（同一引用，调用方可据此跳过该级）', () => {
  const payload = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(foldSystemIntoUser(payload), payload);
});

test('兜底：foldSystemIntoUser 折叠顶层 system 字段（非标准但客户端会发）', () => {
  const payload = {
    system: 'top level rules',
    messages: [{ role: 'user', content: 'hi' }],
  };
  const out = foldSystemIntoUser(payload);
  assert.equal(out.system, undefined, 'top-level system must be removed after folding');
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].content, 'System instructions:\ntop level rules\n\nhi');
});

test('兜底：foldSystemIntoUser 去掉空 system 消息（即使没有可折叠文本）', () => {
  const payload = { messages: [{ role: 'system', content: '' }, { role: 'user', content: 'hi' }] };
  const out = foldSystemIntoUser(payload);
  assert.deepEqual(out.messages.map((m) => m.role), ['user']);
  assert.equal(out.messages[0].content, 'hi');
});

test('兜底：foldSystemIntoUser 保留多段 user 消息里的图片段', () => {
  const payload = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
    ],
  };
  const parts = foldSystemIntoUser(payload).messages[0].content;
  assert.equal(parts[0].text, 'System instructions:\nsys\n\nsee this');
  assert.equal(parts[1].type, 'image_url');
});

test('兜底：obfuscateNonUser 打散 system/assistant 文本，user 与工具入参一字不改', () => {
  const args = '{"path":"D:\\\\x\\\\a.js"}';
  const payload = {
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'Tokens prefixed with @ are paths' },
      { role: 'assistant', content: 'Main branch (you will usually use this for PRs)', tool_calls: [{ id: 'c', type: 'function', function: { name: 'Read', arguments: args } }] },
    ],
  };
  const out = obfuscateNonUser(payload);
  assert.ok(out.messages[0].content.includes(ZWSP));
  assert.equal(out.messages[0].content.replaceAll(ZWSP, ''), 'be terse');
  assert.equal(out.messages[1].content, 'Tokens prefixed with @ are paths', 'user content must stay byte-identical');
  assert.ok(out.messages[2].content.includes(ZWSP));
  assert.equal(out.messages[2].content.replaceAll(ZWSP, ''), 'Main branch (you will usually use this for PRs)');
  assert.equal(out.messages[2].tool_calls[0].function.arguments, args, 'tool arguments must stay byte-identical');
  // 幂等：再打一次不会叠加
  assert.equal(obfuscateNonUser(out).messages[0].content, out.messages[0].content);
});

test('兜底：obfuscateNonUser 没有可打散文本时返回原引用（避免无意义重发）', () => {
  const payload = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(obfuscateNonUser(payload), payload);
  const noSpace = { messages: [{ role: 'assistant', content: '无空格中文' }] };
  assert.equal(obfuscateNonUser(noSpace), noSpace);
});

test('激进模式：品牌词本身也被打散；默认模式不动普通 DeepSeek 叙述', () => {
  const plain = neutralize('DeepSeek V4 is fast');
  assert.equal(plain, 'DeepSeek V4 is fast');
  const aggressive = neutralize('DeepSeek V4 is fast', { aggressive: true });
  assert.ok(!/DeepSeek/i.test(aggressive));
  assert.equal(aggressive.replaceAll(ZWSP, ''), 'DeepSeek V4 is fast');
});

// ---------------------------------------------------------------------------
// 角色归一
// ---------------------------------------------------------------------------

test('角色归一：developer → system（OpenAI 新角色名，老网关不认）', () => {
  const messages = [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }];
  normalizeRoles(messages);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
});

test('首条 system：没有 system 时默认不凭空补（不改语义），显式 synthetic 才补', () => {
  const mk = () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];
  const untouched = mk();
  ensureSystemFirst(untouched);
  assert.deepEqual(untouched.map((m) => m.role), ['user', 'assistant']);

  const synthetic = mk();
  ensureSystemFirst(synthetic, { synthetic: true });
  assert.deepEqual(synthetic[0], { role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  assert.equal(synthetic[1].content, 'hi');
  assert.equal(synthetic.length, 3);
});

test('首条 system：中途已有 system 时提前，不新增占位', () => {
  const sys = { role: 'system', content: 'real system' };
  const messages = [{ role: 'user', content: 'hi' }, sys, { role: 'assistant', content: 'yo' }];
  ensureSystemFirst(messages);
  assert.equal(messages[0], sys);
  assert.equal(messages.length, 3);
});

test('首条 system：首条已是 system 时完全不动', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
  const before = JSON.stringify(messages);
  ensureSystemFirst(messages);
  assert.equal(JSON.stringify(messages), before);
});

// ---------------------------------------------------------------------------
// prepareOutbound：整包改写
// ---------------------------------------------------------------------------

test('整包：messages / tools / tool arguments 里的字符串都被改写，model 字段不动', () => {
  const payload = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'user', content: 'read D:\\x\\DeepSeek Harness\\a.js' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"p":"DeepSeek Harness notes"}' } }],
      },
    ],
    tools: [{ type: 'function', function: { name: 'Read', description: 'DeepSeek Harness helper', parameters: { type: 'object' } } }],
  };
  const { payload: out, rewritten } = prepareOutbound(payload);

  assert.ok(rewritten >= 3, `expected several rewrites, got ${rewritten}`);
  assert.equal(out.model, 'deepseek-v4.1-flash', 'model id must never be rewritten');
  assert.ok(out.messages[0].content.includes(`${ZWSP}`));
  assert.ok(out.messages[1].content.includes('\\DeepSeek Harness\\'), 'path segment kept verbatim');
  assert.ok(out.messages[2].tool_calls[0].function.arguments.includes(ZWSP));
  assert.ok(out.tools[0].function.description.includes(ZWSP));
});

test('整包：developer 打头 → system 打头且不补占位', () => {
  const payload = { messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }] };
  const { payload: out } = prepareOutbound(payload);
  assert.deepEqual(out.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(out.messages[0].content, 'be terse');
});

test('整包：没有 system 时默认保持原形状；syntheticSystem:true 才补占位', () => {
  const mk = () => ({ messages: [{ role: 'user', content: 'hi' }] });
  const natural = prepareOutbound(mk()).payload;
  assert.deepEqual(natural.messages.map((m) => m.role), ['user']);
  const forced = prepareOutbound(mk(), { syntheticSystem: true }).payload;
  assert.deepEqual(forced.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(forced.messages[0].content, DEFAULT_SYSTEM_PROMPT);
});

test('整包：enabled:false 时一个字节都不改（逃生开关）', () => {
  const payload = { messages: [{ role: 'user', content: 'powered by DeepSeek Harness' }] };
  const before = JSON.stringify(payload);
  const { payload: out, rewritten } = prepareOutbound(payload, { enabled: false });
  assert.equal(rewritten, 0);
  assert.equal(JSON.stringify(out), before);
});
