// Central env loading + fail-fast validation.
// The proxy refuses to start with a missing/weak key instead of running exposed.
export const config = {
  port: Number(process.env.PROXY_PORT || 9001),
  // CNB repo slug (org/repo). Falls back to the built-in CNB_BUILD_REPO that
  // always exists inside a CNB workspace, so you rarely need to set this by hand.
  repo: process.env.CNB_REPO_SLUG || process.env.CNB_BUILD_REPO || '',
  proxyKey: process.env.PROXY_KEY || '',
  upstreamToken: process.env.CNB_TOKEN || '',
  // Model ids advertised on /v1/models. Actual routing is done by the CNB gateway;
  // set PROXY_MODELS to whatever your account exposes.
  models: (process.env.PROXY_MODELS || 'deepseek-v4-flash,glm-5.3-flash,kimi-k3').split(',').map((s) => s.trim()).filter(Boolean),
  maxBodyBytes: 4 * 1024 * 1024,
  upstreamTimeoutMs: Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || 15_000), // connect + first byte
  idleTimeoutMs: Number(process.env.PROXY_IDLE_TIMEOUT_MS || 300_000),        // per-stream idle cap (reset each chunk)
  authFailWindowMs: 60_000,
  authFailMax: 10,
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
