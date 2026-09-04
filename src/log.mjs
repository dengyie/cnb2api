// 结构化单行日志：一行一条 JSON，请求级 reqId 串联
import crypto from 'node:crypto';

export function newReqId() {
  return crypto.randomBytes(4).toString('hex');
}

function emit(level, reqId, msg, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, reqId, msg, ...extra });
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (reqId, msg, extra) => emit('info', reqId, msg, extra),
  warn: (reqId, msg, extra) => emit('warn', reqId, msg, extra),
  error: (reqId, msg, extra) => emit('error', reqId, msg, extra),
};
