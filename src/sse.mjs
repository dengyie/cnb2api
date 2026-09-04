// SSE 解析 + 非流式聚合（完整 OpenAI chat.completion 组装）
import { log } from './log.mjs';

// 逐行驱动：把 SSE 文本行流解析成 data 事件
export function sseEvents(text, onEvent) {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue; // 忽略注释/心跳行（": keep-alive"）与非 data 行
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      onEvent(JSON.parse(data));
    } catch (e) {
      log.warn('-', 'sse: unparseable data line', { preview: data.slice(0, 120) });
    }
  }
}

// 聚合上游 SSE 流为完整 OpenAI chat.completion 响应
export function aggregate(text) {
  let id = 'chatcmpl-cnb-proxy', model = 'unknown', created = Math.floor(Date.now() / 1000);
  let content = '', reasoning = '';
  let finishReason = null, usage = null;
  const toolCalls = new Map(); // index -> {id,type,function:{name,arguments}}

  sseEvents(text, (j) => {
    if (j.id) id = j.id;
    if (j.model) model = j.model;
    if (j.created) created = j.created;
    if (j.usage) usage = j.usage;
    const choice = j.choices?.[0];
    if (!choice) return;
    const d = choice.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    for (const tc of d.tool_calls || []) {
      const cur = toolCalls.get(tc.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) cur.id = tc.id;
      if (tc.type) cur.type = tc.type;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      toolCalls.set(tc.index, cur);
    }
  });

  const message = { role: 'assistant' };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (calls.length) message.tool_calls = calls;
  if (!('content' in message) && !calls.length) message.content = '';

  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, usage_estimated: true },
  };
}
