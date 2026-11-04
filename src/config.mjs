// Central env loading + fail-fast validation.
// The proxy refuses to start with a missing/weak key instead of running exposed.
export const config = {
  port: Number(process.env.PROXY_PORT || 9001),
  // CNB repo slug (org/repo). CNB_REPO_SLUG or CNB_BUILD_REPO are built-in
  // variables present in CNB pipelines/workspaces, so you rarely need to set this by hand.
  repo: process.env.CNB_REPO_SLUG || process.env.CNB_BUILD_REPO || '',
  proxyKey: process.env.PROXY_KEY || '',
  upstreamToken: process.env.CNB_TOKEN || '',
  // Model ids advertised on /v1/models when nothing has been sniffed yet.
  // The gateway has no list endpoint, so once a response reveals the real
  // upstream model name (e.g. deepseek-v4.1-flash) it wins; this default is the
  // frozen fallback (see src/models.mjs). Set PROXY_MODELS to whatever your
  // account exposes.
  models: (process.env.PROXY_MODELS || 'deepseek-v4.1-flash,glm-5.3-flash,kimi-k3').split(',').map((s) => s.trim()).filter(Boolean),
  // Where the sniffed-model registry is persisted (survives a workspace hot
  // restart). Relative paths resolve against the process CWD (the run dir).
  modelsStatePath: process.env.PROXY_MODELS_STATE || 'models-state.json',
  maxBodyBytes: 4 * 1024 * 1024,
  upstreamTimeoutMs: Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || 15_000), // connect + first byte
  idleTimeoutMs: Number(process.env.PROXY_IDLE_TIMEOUT_MS || 300_000),        // per-stream idle cap (reset each chunk)
  authFailWindowMs: 60_000,
  authFailMax: 10,
  // 放行客户端的思考开关（reasoning_effort / reasoning / enable_thinking /
  // thinking）到上游 thinking 变体，而不是在出站时剥除。默认关闭：剥除是安全
  // 默认值，理由见 src/proxy.mjs 的剥除说明。开启者必须自行保证 max_tokens
  // 足够大——thinking 变体把推理阶段也计入该预算。
  allowThinking: process.env.CNB2API_ALLOW_THINKING === '1',
  upstreamUrl: '',
};

// UPSTREAM_OVERRIDE is a test-only hook (point the upstream at a local mock).
// In production the upstream is the CNB in-network AI endpoint for this repo.
if (!config.upstreamUrl) {
  config.upstreamUrl = process.env.UPSTREAM_OVERRIDE
    || (config.repo ? `https://api.cnb.cool/${config.repo}/-/ai/chat/completions` : '');
}

if (!config.proxyKey) {
  console.error('[config] PROXY_KEY is required (env). Refusing to start with a default key.');
  process.exit(1);
}
if (!config.upstreamToken) {
  console.error('[config] CNB_TOKEN is required (env, injected by the pipeline stage). Refusing to start.');
  process.exit(1);
}
if (!config.upstreamUrl) {
  console.error('[config] upstream URL is empty: set CNB_REPO_SLUG (org/repo) or UPSTREAM_OVERRIDE. Refusing to start.');
  process.exit(1);
}
// 数字环境变量塞非法值时 Number() 得 NaN，setTimeout(fn, NaN) 按 0ms 立即触发 →
// 每条上游流瞬间 abort，全线不可用。fail-fast 在启动时拦下，而不是带病运行。
for (const [key, env] of [['upstreamTimeoutMs', 'PROXY_UPSTREAM_TIMEOUT_MS'], ['idleTimeoutMs', 'PROXY_IDLE_TIMEOUT_MS']]) {
  if (!Number.isFinite(config[key]) || config[key] <= 0) {
    console.error(`[config] ${env} must be a positive number (ms), got "${process.env[env]}". Refusing to start.`);
    process.exit(1);
  }
}
