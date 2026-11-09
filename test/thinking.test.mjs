// 思考开关策略单测：默认剥除；allow-thinking 时放行并兜底 max_tokens 预算。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  thinkingRequested,
  stripThinking,
  ensureThinkingBudget,
  ensureThinkingEffort,
  effortForBudget,
  applyThinkingPolicy,
  REASONING_TRIGGERS,
  DEFAULT_THINKING_MIN_TOKENS,
  DEFAULT_THINKING_MAX_TOKENS,
} from '../src/thinking.mjs';

test('thinkingRequested：明确的开启形态才算触发', () => {
  assert.equal(thinkingRequested({ reasoning_effort: 'medium' }), true);
  assert.equal(thinkingRequested({ reasoning_effort: 'high' }), true);
  assert.equal(thinkingRequested({ reasoning: { effort: 'high' } }), true);
  assert.equal(thinkingRequested({ reasoning: true }), true);
  assert.equal(thinkingRequested({ enable_thinking: true }), true);
  assert.equal(thinkingRequested({ thinking: true }), true);
  assert.equal(thinkingRequested({ thinking: { type: 'enabled' } }), true);
  assert.equal(thinkingRequested({ thinking: { type: 'enabled', budget_tokens: 2048 } }), true);

  // 客户端明确关闭 / 无关请求不触发
  assert.equal(thinkingRequested({ reasoning_effort: 'none' }), false);
  assert.equal(thinkingRequested({ reasoning: { effort: 'none' } }), false);
  assert.equal(thinkingRequested({ reasoning: { type: 'disabled' } }), false);
  assert.equal(thinkingRequested({ enable_thinking: false }), false);
  assert.equal(thinkingRequested({ thinking: false }), false);
  assert.equal(thinkingRequested({ thinking: { type: 'disabled' } }), false);
  assert.equal(thinkingRequested({ messages: [] }), false);
  assert.equal(thinkingRequested(null), false);
});

test('stripThinking：默认策略在出站前删掉所有思考开关', () => {
  const out = stripThinking({
    model: 'm',
    max_tokens: 1024,
    reasoning_effort: 'high',
    reasoning: { effort: 'high' },
    enable_thinking: true,
    thinking: { type: 'enabled' },
  });
  for (const k of REASONING_TRIGGERS) assert.equal(out[k], undefined, `${k} must be stripped`);
  // 非思考字段原样保留
  assert.equal(out.model, 'm');
  assert.equal(out.max_tokens, 1024);
  // 没有思考开关时返回原对象（幂等、零拷贝）
  const plain = { model: 'm' };
  assert.equal(stripThinking(plain), plain);
});

test('ensureThinkingBudget：低于安全下限抬升，足够大时保持原值', () => {
  // 缺省 max_tokens → 补到安全下限
  assert.equal(ensureThinkingBudget({ model: 'm' }).max_tokens, DEFAULT_THINKING_MIN_TOKENS);
  // 过小 → 抬到下限
  assert.equal(ensureThinkingBudget({ max_tokens: 8192 }).max_tokens, DEFAULT_THINKING_MIN_TOKENS);
  // 已足够 → 不动（返回原对象）
  const enough = { max_tokens: 60000 };
  assert.equal(ensureThinkingBudget(enough), enough);
  // 客户端自己给的更大预算不能被压低
  const huge = { max_tokens: 120000 };
  assert.equal(ensureThinkingBudget(huge), huge);
  // 新版字段名优先
  assert.equal(ensureThinkingBudget({ max_completion_tokens: 4096 }).max_completion_tokens, DEFAULT_THINKING_MIN_TOKENS);
  assert.equal(ensureThinkingBudget({ max_completion_tokens: 4096 }).max_tokens, undefined);
});

test('ensureThinkingBudget：extraTokens 叠加 Anthropic budget_tokens 并受上限约束', () => {
  // 32000 + 2048，已在下限之上 → 保留叠加结果
  assert.equal(ensureThinkingBudget({ max_tokens: 32000 }, { extraTokens: 2048 }).max_tokens, 34048);
  // 60000 + 60000 = 120000 → 自动抬升上限 64000
  assert.equal(ensureThinkingBudget({ max_tokens: 60000 }, { extraTokens: 60000 }).max_tokens, 64000);
  // 自定义上下限
  assert.equal(ensureThinkingBudget({ max_tokens: 100 }, { minTokens: 1000, maxTokens: 2000, extraTokens: 500 }).max_tokens, 1000);
});

test('applyThinkingPolicy：未开 allowThinking 剥除，开启后放行并兜底预算', () => {
  const payload = { model: 'm', max_tokens: 2048, reasoning_effort: 'high', messages: [] };

  const stripped = applyThinkingPolicy(payload, { allowThinking: false });
  assert.equal(stripped.reasoning_effort, undefined);
  assert.equal(stripped.max_tokens, 2048, 'strip path must not touch max_tokens');

  const allowed = applyThinkingPolicy(payload, { allowThinking: true });
  assert.equal(allowed.reasoning_effort, 'high', 'toggle must be forwarded on opt-in');
  assert.equal(allowed.max_tokens, DEFAULT_THINKING_MIN_TOKENS, 'small budget must be raised');

  // 只有 thinking：放行时补 reasoning_effort，否则上游不切变体
  const thinkingOnly = applyThinkingPolicy({ model: 'm', max_tokens: 2048, thinking: { type: 'enabled' } }, { allowThinking: true });
  assert.equal(thinkingOnly.thinking.type, 'enabled');
  assert.equal(thinkingOnly.reasoning_effort, 'medium');
  assert.equal(thinkingOnly.max_tokens, DEFAULT_THINKING_MIN_TOKENS);

  // 无思考开关的请求两种模式下都原样返回
  const plain = { model: 'm', max_tokens: 1024, messages: [] };
  assert.equal(applyThinkingPolicy(plain, { allowThinking: false }), plain);
  assert.equal(applyThinkingPolicy(plain, { allowThinking: true }), plain);
  assert.equal(applyThinkingPolicy(plain, { allowThinking: true }).max_tokens, 1024);
});

test('ensureThinkingEffort：只有 thinking/enable_thinking 时补 reasoning_effort（上游只认它）', () => {
  // 2026-11-09 线上实测：三种命名单独发都不切 thinking 变体，必须带 reasoning_effort
  const t = ensureThinkingEffort({ thinking: { type: 'enabled' } });
  assert.equal(t.reasoning_effort, 'medium');
  const e = ensureThinkingEffort({ enable_thinking: true });
  assert.equal(e.reasoning_effort, 'medium');
  const r = ensureThinkingEffort({ reasoning: { effort: 'high' } });
  assert.equal(r.reasoning_effort, 'medium');
  // 客户端已显式给了就尊重（包括明确关闭）
  const explicit = { reasoning_effort: 'high', thinking: { type: 'enabled' } };
  assert.equal(ensureThinkingEffort(explicit), explicit);
  const off = ensureThinkingEffort({ reasoning_effort: 'none', thinking: { type: 'enabled' } });
  assert.equal(off.reasoning_effort, 'none');
  // 没有思考请求 → 原对象
  const plain = { messages: [] };
  assert.equal(ensureThinkingEffort(plain), plain);
});

test('effortForBudget：Anthropic budget_tokens → 强度档位', () => {
  assert.equal(effortForBudget(2048), 'low');
  assert.equal(effortForBudget(4096), 'low');
  assert.equal(effortForBudget(8192), 'medium');
  assert.equal(effortForBudget(16384), 'medium');
  assert.equal(effortForBudget(16385), 'high');
  assert.equal(effortForBudget(31999), 'high');
  assert.equal(effortForBudget(undefined), 'medium');
  assert.equal(effortForBudget('many'), 'medium');
  assert.equal(effortForBudget(0), 'medium');
});

test('applyThinkingPolicy：非对象 payload 安全透传', () => {
  assert.equal(applyThinkingPolicy(null), null);
  assert.deepEqual(applyThinkingPolicy([{ reasoning_effort: 'high' }]), [{ reasoning_effort: 'high' }]);
});
