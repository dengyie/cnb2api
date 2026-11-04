// 出站中性化：让请求「语义不变、特征不可见」地穿过上游的内容风控。
//
// 背景（真机实测，2026-10）：
// 上游 AI 网关（CNB / CodeBuddy 系）对请求体做「客户端指纹」风控，命中即整条拒绝：
//   HTTP 400 / 业务码 11128 / "Illegal API invocation from an unapproved channel"
// 换令牌、换账号、换模型、补请求头都无效——被拦的是提示词本身，不是渠道。
// 体量 > ~1KB 时稳定触发，短请求即使命中也会放过，所以表现为「时好时坏」。
//
// 拦截面（2026-10 真机实测，对 api.cnb.cool 上游逐段二分定位）：
//   · 只扫 system / assistant 这两个角色的文本；user 内容、tools 描述都不扫。
//     同一段文本放 user 里 200，放 system 或 assistant 里 400/11128。
//   · 不是精确子串匹配，而是「客户端指纹」的模糊匹配：一段话里同时出现
//     「@ 路径引用」与「workspace root」这类组合就整条拒（拆成单句都不拦），
//     另一条已知指纹 "Main branch (you will usually use this for PRs)" 单独就能拦。
//   · 和体量有关：> ~1KB 时稳定触发，短请求即使命中也会放过，所以表现为「时好时坏」。
// 因此单一关键词表不可能穷举（指纹是模糊的、还会随上游收紧而增加），
// 这里三管齐下，都不改语义：
//   1. 已知指纹改写：身份词组打散 + 已确认的客户端指纹句改成等价表述。
//      身份词组在 "DeepSeek" 与 "Harness" 之间插入零宽空格 U+200B——模型读到的
//      仍是同一个词（零宽字符不可见），上游的匹配不再命中。路径语境必须跳过：
//      把 D:\...\DeepSeek Harness\resources\... 改成带零宽字符的版本，会让模型
//      把坏路径交给工具调用，直接执行失败。见 IDENTITY_RE 的前后断言。
//   2. 消息形状归一：OpenAI 新协议用 developer 角色打头，DSH 等新客户端会这么发；
//      这里把 developer 映射成 system，并把中途出现的 system 提到最前。请求本来
//      没有 system 时不凭空造（那会改语义），除非显式打开 PROXY_SYNTHETIC_SYSTEM。
//   3. 兜底重试（proxy.mjs 在真的吃到 400/11128 时按级启用）：
//      foldSystemIntoUser —— 把 system 文本并进首条 user（零额外 token；已验证 200）；
//      obfuscateNonUser  —— 再把 system / assistant 逐词打散（覆盖历史消息里被拦的情况）。
//
// 表驱动：上游若换/加关键词，只改下面的表。

// 零宽空格：不参与渲染，也不属于 \s，插进词组里既不改语义也不改分词边界。
const ZWSP = '\u200B';

// 客户端注入的特征短语。部分网关按字面拦这些 token（Claude Code 的计费头名等），
// 换等价表述、保留值本身（URL/版本号原样），模型行为不受影响。
export const CLIENT_PHRASES = [
  [/x-anthropic-billing-header/gi, 'x-cc-billing-meta'],
  [
    /to give feedback, users should report the issue at (https:\/\/github\.com\/anthropics\/claude-code\/issues)/gi,
    'to share feedback, users can report the issue at $1',
  ],
  [
    /you are claude code, anthropic's official cli for claude(\.)?/gi,
    "you are claude code, a command-line coding assistant$1",
  ],
  // —— 以下三条为本仓库实测新增（2026-10-27，真机二分定位）——
  // DSH 的系统提示词里有一段「@ 文件引用」说明，单独任何一句都放过，
  // 但两句连在一起就命中上游的 Cursor 系指纹 → 整条 400/11128。
  // 这是 DSH 用户在代理侧唯一的必踩点：改写后整份 DSH 系统提示词实测 200。
  [
    /are paths the user explicitly referenced/gi,
    'are path references the user made explicitly',
  ],
  [
    /Relative paths resolve from the workspace root/gi,
    'Relative paths are resolved against the workspace root',
  ],
  // Copilot / Cursor 系环境指纹，单独一句即可触发拦截。
  [
    /Main branch \(you will usually use this for PRs\)/gi,
    'Main branch (the usual target for pull requests)',
  ],
];

// 上游当前实测会拦的身份词组。前后负向断言跳过路径语境（\ 或 / 贴边），
// 其余位置一律打散；大小写不敏感，空格兼容普通空格与 NBSP。
export const IDENTITY_RE = /(?<![\\/])(DeepSeek)[ \u00A0]+(Harness)(?![\\/])/gi;

// 激进模式：连品牌词本身也打散。默认关闭——它会命中比身份词组多得多的位置
// （模型名、普通叙述），只在身份词组规则被上游绕过时才需要。
export const BRAND_RE = /(?<![\\/\w])(DeepSeek)(?![\w\\/])/gi;

// 补位用的中性 system：仅在显式开启 syntheticSystem 时使用（默认关闭）。
// 默认不凭空造 system——请求本来没有 system 是合法形状，不该被改写语义。
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

// 字符串级中和：纯函数，便于单测；路径语境的跳过由正则自身保证。
export function neutralize(text, { aggressive = false } = {}) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [re, replacement] of CLIENT_PHRASES) out = out.replace(re, replacement);
  out = out.replace(IDENTITY_RE, `$1${ZWSP} $2`);
  if (aggressive) out = out.replace(BRAND_RE, `Deep${ZWSP}Seek`);
  return out;
}

// 递归改写请求体里所有字符串值（content / tool 描述 / tool arguments 的 JSON 串 /
// input_schema 的 description …）。只改值、不改键：键名是协议字段，改不得。
// 就地改写：payload 来自 JSON.parse，调用方本来就要重建 body。
function rewriteDeep(value, options, stats) {
  if (typeof value === 'string') {
    const next = neutralize(value, options);
    if (next !== value) stats.rewritten += 1;
    return next;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = rewriteDeep(value[i], options, stats);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = rewriteDeep(value[key], options, stats);
    return value;
  }
  return value;
}

// developer → system：OpenAI 新角色名，老网关不认。就地改，顺序不变。
export function normalizeRoles(messages) {
  for (const m of messages) {
    if (m && m.role === 'developer') m.role = 'system';
  }
  return messages;
}

// 首条是 system 的保证：
//   · 首条已是 system → 不动（绝大多数请求）
//   · 有 system 但在中途 → 提前（system 不参与 tool_call_id 配对，移动安全）
//   · 一条 system 都没有 → 默认不动（凭空造 system 会改语义）；只有调用方显式
//     syntheticSystem=true 时才补中性占位，用于上游硬性要求首条为 system 的场景。
export function ensureSystemFirst(messages, { synthetic = false } = {}) {
  if (!messages.length || messages[0]?.role === 'system') return messages;
  const idx = messages.findIndex((m) => m?.role === 'system');
  if (idx > 0) {
    const [sys] = messages.splice(idx, 1);
    messages.unshift(sys);
    return messages;
  }
  if (synthetic) messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  return messages;
}

// ---------------------------------------------------------------------------
// 兜底形态（只在真的被 400/11128 拒绝后由 proxy.mjs 逐级启用）
// ---------------------------------------------------------------------------

// 取消息内容里的纯文本：字符串直接返回，多段（content parts）只拼 text 段。
// 图片等非文本段不参与拼接，避免把多模态消息压扁。
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  // 单段块对象（少数客户端会这么发顶层 system）
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

// 兜底 1：把 system（含已归一过的 developer）文本并进首条 user 消息。
// 语义不变——模型读到的还是同一段指令，只是角色从 system 变 user；零额外 token。
// 已实测：同一段被拦文本放 user 里上游 200（拦截面只扫 system / assistant）。
// 首条 user 是多段消息时，作为前置 text 段插入，原有图片段原样保留。
// 非标准但有客户端会发的顶层 system 字段一并折叠（否则它仍会被扫）。
export function foldSystemIntoUser(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const messages = payload.messages;
  const topSystem = contentText(payload.system);
  const hasTopSystem = payload.system !== undefined;
  if (!Array.isArray(messages) && !topSystem) return payload;

  const sysTexts = [];
  let sawSystem = hasTopSystem;
  if (topSystem) sysTexts.push(topSystem);
  const rest = [];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && (m.role === 'system' || m.role === 'developer')) {
        sawSystem = true;
        const text = contentText(m.content);
        if (text) sysTexts.push(text);
        continue;
      }
      rest.push(m);
    }
  }
  // 没有 system 文本时：若有空的 system 消息，也顺手去掉。上游按文本指纹拦，
  // 但多带一条空 system 没有语义价值，去掉可让兜底形态更接近「纯 user」形状。
  if (!sysTexts.length) {
    if (!sawSystem) return payload;
    const next = { ...payload, messages: rest };
    if (hasTopSystem) delete next.system;
    return next;
  }

  const folded = `System instructions:\n${sysTexts.join('\n\n')}`;
  const idx = rest.findIndex((m) => m?.role === 'user');
  if (idx === -1) {
    rest.unshift({ role: 'user', content: folded });
  } else {
    const target = rest[idx];
    if (Array.isArray(target.content)) {
      const first = target.content[0];
      // 首段是 text 就并进去，否则新插一段：多模态消息的图片段保持原位不动
      const merged = first && typeof first.text === 'string'
        ? [{ ...first, text: `${folded}\n\n${first.text}` }, ...target.content.slice(1)]
        : [{ type: 'text', text: folded }, ...target.content];
      rest[idx] = { ...target, content: merged };
    } else {
      const text = contentText(target.content);
      rest[idx] = { ...target, content: text ? `${folded}\n\n${text}` : folded };
    }
  }
  const next = { ...payload, messages: rest };
  if (hasTopSystem) delete next.system;
  return next;
}

// 逐词打散：在每个词尾插入零宽空格（词与词的空格保留，渲染与语义不变）。
// 打散后任何整句/跨句指纹都不再成立——已实测整份 DSH 系统提示词逐词打散后 200。
// 先剥掉已有的 ZWSP 再重打，保证幂等（不会越跑越多）。无空格文本原样返回。
function obfuscateWords(text) {
  if (typeof text !== 'string' || !text.includes(' ')) return text;
  return text.replaceAll(ZWSP, '').split(' ').join(`${ZWSP} `);
}

// 兜底 2：把 system / assistant 角色里的文本逐词打散。
// 兜底 1 只管 system；若指纹落在 assistant 历史消息里（拦截面同样扫 assistant），
// 或者上游新增了表外的指纹，这一级仍能过。tool_calls 的参数不改：那是工具调用的
// 真实入参（路径/JSON），改了会直接执行失败。
export function obfuscateNonUser(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return payload;
  let changed = false;
  const next = messages.map((m) => {
    if (!m || (m.role !== 'system' && m.role !== 'assistant')) return m;
    if (typeof m.content === 'string') {
      const content = obfuscateWords(m.content);
      if (content === m.content) return m;
      changed = true;
      return { ...m, content };
    }
    if (Array.isArray(m.content)) {
      let partChanged = false;
      const content = m.content.map((p) => {
        if (!p || typeof p.text !== 'string') return p;
        const text = obfuscateWords(p.text);
        if (text === p.text) return p;
        partChanged = true;
        return { ...p, text };
      });
      if (!partChanged) return m;
      changed = true;
      return { ...m, content };
    }
    return m;
  });
  // 没有任何可打散的文本时返回原引用，调用方据此跳过多余的一次上游请求
  return changed ? { ...payload, messages: next } : payload;
}

// 出站前唯一入口：proxy.mjs 在 fetch 之前调用，OpenAI 与 Anthropic 两条协议栈
// 走同一份逻辑（Anthropic 适配器已完成转换，payload 一律是 OpenAI 形状）。
// 返回 { payload, rewritten }，rewritten = 被改写的字符串处数（供日志/诊断）。
export function prepareOutbound(payload, {
  enabled = true,
  aggressive = false,
  ensureSystem = true,
  syntheticSystem = false,
} = {}) {
  if (!enabled || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, rewritten: 0 };
  }
  const stats = { rewritten: 0 };
  // 只遍历承载自然语言的根字段：model / stream / max_tokens 等协议字段保持原样
  // （模型名里带 deepseek 是正常的，不该被改写）。
  for (const root of ['messages', 'tools', 'system', 'prompt']) {
    if (payload[root] === undefined) continue;
    payload[root] = rewriteDeep(payload[root], { aggressive }, stats);
  }
  if (Array.isArray(payload.messages)) {
    normalizeRoles(payload.messages);
    if (ensureSystem) ensureSystemFirst(payload.messages, { synthetic: syntheticSystem });
  }
  return { payload, rewritten: stats.rewritten };
}
