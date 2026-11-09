// 思考开关策略：默认剥除；部署显式开 CNB2API_ALLOW_THINKING=1 时放行并兜底预算。
//
// 上游 thinking 变体把推理阶段也计入 max_tokens：预算不足时推理吃满、
// finish_reason=length、content 全空（2026-10-04 生产抓帧
// {'reasoning_only':1024,'empty':2}）。所以"放行思考"不能只把开关透传过去，
// 必须同时保证输出预算足够——低于安全下限就抬到下限，Anthropic 的
// thinking.budget_tokens 另外叠加（见 src/anthropic.mjs）。
//
// 表驱动：上游若引入新的思考开关命名，往这张表加一项即可。

export const REASONING_TRIGGERS = ['reasoning_effort', 'reasoning', 'enable_thinking', 'thinking'];

// 预算兜底的安全下限/上限：32k 是能容下推理 + 正文的起点，60k 已在真机验证；
// 上限只约束"自动抬升"的值，客户端自己给的更大预算不会被压低。
export const DEFAULT_THINKING_MIN_TOKENS = 32_768;
export const DEFAULT_THINKING_MAX_TOKENS = 64_000;
// 上游只认 reasoning_effort 这一个强度字段；thinking / enable_thinking 单独发
// 不会路由到 thinking 变体（2026-11-09 线上实测：三种命名单独发 reasoningChars=0，
// 只有 reasoning_effort 非 none 时上游才产出 reasoning_content）。
export const DEFAULT_THINKING_EFFORT = 'medium';

// Anthropic 只有 thinking.budget_tokens、没有强度字段。上游要 reasoning_effort
// 才会切 thinking 变体，所以按预算档位折算（预算本身另有 max_tokens 叠加）。
export function effortForBudget(budgetTokens, fallback = DEFAULT_THINKING_EFFORT) {
  const n = Number(budgetTokens);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n <= 4_096) return 'low';
  if (n <= 16_384) return 'medium';
  return 'high';
}

// 明确表达"要思考"才算触发：false / 'none' / {type:'disabled'} 是客户端明确关闭，
// 不能因为字段存在就误判成开启。
export function thinkingRequested(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

  const effort = payload.reasoning_effort;
  if (typeof effort === 'string' && effort && effort !== 'none') return true;
  if (effort !== undefined && effort !== null && typeof effort !== 'string') return true;

  const reasoning = payload.reasoning;
  if (reasoning === true) return true;
  if (reasoning && typeof reasoning === 'object') {
    if (reasoning.enabled === false || reasoning.type === 'disabled') return false;
    if (typeof reasoning.effort === 'string' && reasoning.effort === 'none') return false;
    return true;
  }

  if (payload.enable_thinking === true) return true;

  const thinking = payload.thinking;
  if (thinking === true) return true;
  if (thinking && typeof thinking === 'object') {
    if (thinking.type === 'disabled' || thinking.enabled === false) return false;
    return true;
  }
  return false;
}

// 出站补齐强度字段：客户端只发 thinking / enable_thinking / reasoning 时上游不会
// 切 thinking 变体，这里补一个合法的 reasoning_effort（已显式给了就尊重原值，
// 包括 'none' 这种明确关闭）。
export function ensureThinkingEffort(payload, defaultEffort = DEFAULT_THINKING_EFFORT) {
  if (!thinkingRequested(payload)) return payload;
  if (typeof payload.reasoning_effort === 'string') return payload;
  return { ...payload, reasoning_effort: defaultEffort };
}

// 出站删除所有思考开关（安全默认值）：锁定非 thinking 变体。
export function stripThinking(payload) {
  if (!REASONING_TRIGGERS.some((k) => k in payload)) return payload;
  const out = { ...payload };
  for (const k of REASONING_TRIGGERS) delete out[k];
  return out;
}

// 放行思考时把输出预算抬到安全下限；extraTokens 用于叠加 Anthropic 的
// budget_tokens（上游不认这个字段，只能折进 max_tokens）。返回新对象或原对象。
export function ensureThinkingBudget(payload, {
  minTokens = DEFAULT_THINKING_MIN_TOKENS,
  maxTokens = DEFAULT_THINKING_MAX_TOKENS,
  extraTokens = 0,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const key = 'max_completion_tokens' in payload ? 'max_completion_tokens' : 'max_tokens';
  const raw = Number(payload[key]);
  const current = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const wanted = Math.max(minTokens, current + Math.max(0, Number(extraTokens) || 0));

  // 只抬不压：客户端显式给的预算已经够大就原样保留，避免突破它的成本预期
  let budget = Math.max(wanted, current);
  if (maxTokens > 0) budget = Math.min(budget, Math.max(maxTokens, current));
  if (budget === current) return payload;

  const out = { ...payload };
  out[key] = budget;
  return out;
}

// 统一入口：未要求思考 → 原样返回；未开启放行 → 剥除；开启 → 保留开关并兜底预算。
export function applyThinkingPolicy(payload, {
  allowThinking = false,
  minTokens = DEFAULT_THINKING_MIN_TOKENS,
  maxTokens = DEFAULT_THINKING_MAX_TOKENS,
  extraTokens = 0,
} = {}) {
  if (!thinkingRequested(payload)) return payload;
  if (!allowThinking) return stripThinking(payload);
  const withEffort = ensureThinkingEffort(payload);
  return ensureThinkingBudget(withEffort, { minTokens, maxTokens, extraTokens });
}
