// token usage accumulator, aggregated in memory per boot (workspace recycle = new
// boot starting from zero). The /usage endpoint exposes the snapshot so external
// sync/monitoring can diff by boot_id — same boot reports are incremental, boots
// never double-count; only the tail <1 sync-cycle before a recycle is unaccounted.
export const bootedAt = Date.now();
export const bootId = `${process.pid.toString(36)}-${bootedAt.toString(36)}`;

const totals = { prompt: 0, completion: 0, requests: 0, errors: 0 };

// prompt/completion：上游 usage 精确值；usage 缺失（如流被中止）时仅计请求/错误
export function record({ prompt = 0, completion = 0, requests = 1, errors = 0 } = {}) {
  totals.prompt += prompt;
  totals.completion += completion;
  totals.requests += requests;
  totals.errors += errors;
}

export function snapshot() {
  return {
    boot_id: bootId,
    booted_at: new Date(bootedAt).toISOString(),
    totals: { ...totals },
  };
}
