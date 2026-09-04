// Key 鉴权 + 失败计数限速（滑动窗口；恒时比较防时序侧信道）
import crypto from 'node:crypto';
import { config } from './config.mjs';

const failures = []; // 时间戳数组，仅记录失败请求

function prune(now) {
  while (failures.length && now - failures[0] > config.authFailWindowMs) failures.shift();
}

export function checkAuth(req) {
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${config.proxyKey}`;
  const ok = auth.length === expected.length && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
  if (ok) return { ok: true };

  const now = Date.now();
  prune(now);
  failures.push(now);
  const retryAfterSec = Math.ceil((config.authFailWindowMs - (now - failures[0])) / 1000);
  if (failures.length > config.authFailMax) {
    return { ok: false, status: 429, body: { error: { message: 'too many failed auth attempts, slow down', type: 'rate_limit_error' } }, retryAfterSec };
  }
  return { ok: false, status: 401, body: { error: { message: 'invalid api key', type: 'auth_error' } } };
}
