<div align="center">

# cnb2api

**将 CNB 云原生工作区内网 AI 转化为高可用生产级 API 网关**

**每月免费获取最高 2 亿 DeepSeek Tokens · 零外部依赖 · 7×24h 自愈高可用**

*OpenAI + Anthropic 双协议栈 · Claude Code 零配置直连 · v5.2 架构 · 终端额度看板*

[![Tokens](https://img.shields.io/badge/DeepSeek%20Tokens-%E6%AF%8F%E6%9C%88%E6%9C%80%E9%AB%98%202%20%E4%BA%BF%20(Free)-10a37f?style=flat&logo=deepseek)](#quota-calc)
[![test](https://github.com/dengyie/cnb2api/actions/workflows/test.yml/badge.svg)](https://github.com/dengyie/cnb2api/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · 简体中文

</div>

> **一句话简介**：CNB 每月向每个认证组织免费赠送 **500~1,166 AI Credits** 与 **1,600 核时**。搭配官方 Prompt Cache，**每月最高可享约 2 亿 DeepSeek Tokens 免费额度**！但该 AI 端点严格受限于工作区内网与流水线临时 Token，且容器每天过夜回收。**cnb2api** 部署在工作区内，零外部依赖将其转换为标准公网 API，并通过独创的 **v5.2 双保险自愈架构** 实现永久固定域名访问与 7×24 小时高可用。

---

### 为什么选择 cnb2api？

| 维度 | cnb2api（本项目） | 社区逆向 NPC 方案 | 直接公网调用 |
|:---|:---|:---|:---|
| **每月可用额度** | **最高 ~2 亿 DeepSeek Tokens**（1,166 Credits + 缓存优化） | 随时受限、被风控限频 | 0（物理隔离无法调用） |
| **调用途径** | **官方工作区内网端点** | 网页前端匿名游客 NPC 接口 | 官方公网端点 |
| **账号合规** | **100% 官方合规**，消耗自有正规配额 | 逆向抓包、违反 ToS、易封号 | 无法调用（网络策略拦截） |
| **网络可达性** | 内网反代 + 动态中继，**公网稳定访问** | 需维护无头浏览器/代理池抓 CSRF | ❌ 403 `Blocked by network policy` |
| **鉴权机制** | 流水线即时签发 `CNB_TOKEN`（零保管） | 抓取网页 cookie / session | ❌ 个人令牌 403（仅限流水线） |
| **协议支持** | **OpenAI + Anthropic 双协议栈** | 仅部分模拟 OpenAI 基础文本 | 无 |
| **Claude Code 直连** | **原生直连**（内置 11128 误报规避） | ❌ 不支持（缺 Tool Calling / 被拦截） | 无 |
| **原生 Tool Calling** | **完整透传**（流式增量合并 + 非流式聚合） | ❌ 不支持 | 无 |
| **外部运行依赖** | **0 依赖**（Node.js 22+ 原生标准库） | 需安装 Chromium / Puppeteer | 无 |
| **高可用机制** | **v5.2 双保险自愈**（内网 cron + 外部看门狗） | 页面一改版即报废 | 无 |
| **额度透明度** | **内置终端看板 CLI** + `/usage` 统计 | 黑盒无明细 | 仅控制台深处可看 |

---

### 核心特性

- 💰 **每月最高 2 亿 DeepSeek 免费 Tokens**：
  - 充分释放 CNB 官方每月赠送的 500~1,166 AI Credits。
  - 官方底层自带 **30 倍 Prompt Cache 缓存折扣**。在编程开发、Claude Code、Agent 多轮循环等高频上下文复用场景下，折算综合可用量高达 **2 亿 Tokens/月**，彻底告别商业 API 用量焦虑。
- ⚡ **双协议栈原生支持**：
  - **OpenAI 兼容**：`/v1/chat/completions` 与 `/v1/models`，支持流式 SSE 透传与忠实的非流式状态机聚合（完整回填 `usage`、真实 `credit` 扣费、`tool_calls` 与 `finish_reason`）。
  - **Anthropic 兼容**：`/v1/messages` 与 `/v1/messages/count_tokens`，**Claude Code CLI 零中间件直连**，完整支持思考链（thinking）、多轮工具调用与事件流。
  - 🛡️ **出站中性化规避**：自动等价重写 Claude Code 内部计费头与特征提示词短语，语义无损消除上游网关对 Claude Code 的 11128 误拦截。
- ♻️ **v5.2 零凭据 + 双保险自愈架构**：
  - **凭据零保管**：工作区内零静态长期 Token，定时自愈流水线每次使用平台即时签发、任务结束即销毁的临时 `CNB_TOKEN`。
  - **动态域名自动跟随**：工作区开机自动向中继注册新子域名（`/ops/register`），中继热重载 upstream，客户端固定域名与 Key 永久不变；实测自愈恢复仅需 **~2 分 13 秒**。
  - **防休眠看门狗**：外部看门狗（`cnb-watchdog.sh`）监控 CI 平台定时流水线休眠机制，连续失败时自动触发带冷却锁的 OpenAPI 应急拉起，23 秒恢复且真故障才报警。
- 🪶 **极简零依赖（Zero Dependencies）**：纯 Node.js 22+ 内置模块实现（原生 `fetch`、`ReadableStream`、`crypto.timingSafeEqual`、`node:test`），零 `npm install`，毫秒启动。
- 📊 **多维用量监控与独家额度看板**：
  - 终端一键查额度 `cnb2api-quota`：彩色 ANSI 进度条直观展示 AI Credits、开发核时、CI 核时及在途冻结额度，支持 `--json` 与 `--line`。
  - 内存级 `GET /usage` 统计端点，按 boot 隔离并支持 UTC+8 每日对账，完美适配自建看板与探针监控。

---

## 工作原理

```
客户端 (OpenAI 客户端 / Claude Code / API 网关)
  │  https://ai.example.com/v1 (固定域名，自建 Nginx 中继)
  ▼
https://<动态子域名>-9001.cnb.run (CNB 端口代理，每次开机通过 /ops/register 自动同步)
  │
  ▼
node src/server.mjs (工作区内网 9001 端口，cnb2api 反代)
  │  Bearer CNB_TOKEN (平台流水线自动签发，CNB 内网)
  ▼
https://api.cnb.cool/<org>/<repo>/-/ai/chat/completions (官方 AI 核心端点)
```

工作区被当作**牲口而非宠物（Cattle, not Pet）**：
1. **定时自愈**：平台内网 cron（`*/5 * * * *`）探活，发现工作区停止自动发起 `workspace/start`。
2. **开机自注册**：工作区启动后执行脚本（`deploy/start.sh`），将新分配的子域名 POST 到中继的 `/ops/register`，Nginx 自动更新 upstream 并 reload。
3. **外部兜底**：VPS 外部看门狗（`cnb-watchdog.sh`）监控固定域名，防范 CI 平台长时间无提交导致的定时任务休眠。

---

## 快速开始

三步走，仅需配置一个 API Key：

1. **私有 Fork 本仓**：在 CNB 上将本仓库 Fork 为**私有仓库**。
2. **配置 API Key**：在仓库 `.cnb.yml` 的 `env:` 块填入自定义的 `PROXY_KEY`（如 `openssl rand -hex 24`）。
3. **启动云开发工作区**：点击 CNB 网页的「启动云原生开发」，构建日志打印出 `PROXY_URI=https://<子域名>-9001.cnb.run` 即可直接使用！

> 💡 需要永久固定域名？只需配置一个 VPS 运行简单的 Nginx 反代并开启 `/ops/register`，详见 [完整部署指南 (docs/SETUP.md)](docs/SETUP.md)。

---

## 客户端接入示例

### 1. Claude Code 直连（原生 Anthropic 协议）
```bash
ANTHROPIC_BASE_URL=https://ai.example.com \
ANTHROPIC_AUTH_TOKEN=your-proxy-key \
ANTHROPIC_MODEL=deepseek-v4.1-flash \
claude -p "你好，请介绍一下你自己"
```

### 2. OpenAI 客户端 / 聚合网关
将 BaseURL 指向 `https://ai.example.com/v1`，API Key 填入 `PROXY_KEY`：
- **聊天应用**：NextChat、LobeChat、Cherry Studio、Open WebUI
- **网关渠道**：New API、One API（渠道类型选择 OpenAI，模型填 `deepseek-v4.1-flash`）
- **代码插件**：Cursor、Continue、Codex CLI

### 3. curl 调用验证
```bash
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

---

<span id="quota-calc"></span>
## 额度与成本测算：如何做到每月 2 亿 Tokens？

这是基于长期线上实测的真实扣费数据，非营销宣传：

| 资源配额 | 每月免费总量 | 消耗与折算说明 |
|:---|:---|:---|
| **AI Credits** | 基础 **500**，完成 *hello-cnb* 闯关后达 **1,166** | 每一次 AI 请求响应的 `usage` 均上报真实扣费 `credit`。结合 Prompt Cache 最高可换算 **~2 亿 Tokens/月**。 |
| **算力核时** | **1,600 核时**（dev + CI 共享池） | `runner.cpus: 2` 反代工作区整月 30 天 7×24h 不间断运行仅消耗 **1,440 核时**（完全在免费池内），无需关机省核时。 |

> 💡 **2 亿 Tokens/月的实测换算逻辑**：
> 1. **官方基础定价**：对 `deepseek-v4.1-flash` 实测，全新未命中缓存的请求约 9,000 tokens 花费 0.39 credit（约 **2.3 万 tokens / credit**）。
> 2. **官方 Prompt Cache 30倍优惠**：命中 CNB 的 prompt 缓存后降至 **~0.01 credit**，相当于基准价格的 **1/30**（约 **70 万 tokens / credit**）。
> 3. **综合场景折算**：在 Cursor、Claude Code、Agent 编码等多轮对话和长 System Prompt 场景下，上下文缓存命中率通常在 80%~95%（取典型 **90% 命中率**）：
>    $$\text{综合成本} = 10\% \times 1 + 90\% \times \frac{1}{30} \approx 13\% \text{ 原价} \implies \approx 17.7\text{ 万 tokens / credit}$$
>    $$\text{月度额度} = 1,166\text{ credits} \times 17.7\text{ 万 tokens} \approx \mathbf{2.06\text{ 亿 tokens / 月}}$$
> 4. 终端执行 `npm run quota` 可随时查看你当前组织账号的实时剩余额度。

---

## 额度看板 (CLI)

在终端一键直连官方 Charge 计费接口，即使反代未开机也能查询：

```bash
npm run quota                 # 或: npx cnb2api-quota
```

```text
  ◆ CNB quota  your-org

  Credits  ███████▋───────────────────  32%   320.0 / 1,000.0 cr
  Dev      ██████▏─────────────────────  25%   406.4 / 1,600.0 core-h
  CI       █▋──────────────────────────   8%   13.0 / 160.0 core-h

  in-flight (not yet settled): 12.0 cr, 0.8 core-h
  remaining credits: 680.0 cr   as of 2026-01-15 08:30:00 UTC
```

- `cnb2api-quota --line`：单行紧凑模式，适合嵌入状态栏或 Shell 提示符。
- `cnb2api-quota --json`：标准 JSON 输出，便于脚本采集自动化。

---

## 配置项参考

| 环境变量 | 默认值 | 说明 |
|:---|:---|:---|
| `PROXY_KEY` | — (必填) | 客户端访问反代网关的 Bearer Token / x-api-key。 |
| `CNB_TOKEN` | — (必填) | CNB 内网端点鉴权令牌，流水线环境自动注入。 |
| `CNB_REPO_SLUG` | (内置) | 当前仓库 `org/repo`，流水线内置自动填充。 |
| `PROXY_MODELS` | `deepseek-v4.1-flash,glm-5.3-flash,kimi-k3` | **兜底**模型列表：仅在尚未嗅探到真实上游模型名时用于 `/v1/models`。 |
| `PROXY_MODELS_STATE` | `models-state.json` | 嗅探到的模型名注册表的持久化路径，跨工作区重启保留。相对路径相对于运行目录解析。 |
| `PROXY_PORT` | `9001` | 服务监听端口。 |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `15000` | 上游连接首字节超时 (ms)。 |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | 流式事件空闲超时看门狗 (ms)。 |
| `CNB2API_ALLOW_THINKING` | 关闭 | 设为 `1` 时，把客户端的思考开关（`reasoning_effort` / `reasoning` / `enable_thinking` / `thinking`，以及 Anthropic 的 `thinking:{type:"enabled"}`）透传到上游 thinking 变体，而不是出站剥除。仅在客户端会给出足够大 `max_tokens` 时开启——详见下方说明。 |
| `REGISTER_URL` | — (可选) | 中继自注册 `/ops/register` 地址。 |
| `REG_TOKEN` | — (可选) | 中继自注册鉴权密钥。 |

### 默认剥除思考开关

上游 thinking 变体会把推理阶段计入 `max_tokens`。预算偏小时推理吃满全部额度，流以
`finish_reason: length` 结束且**答案永不产出**（实测：硬 prompt 在 `max_tokens` 2048 与
8192 下分别产出 4.6k / 20.3k 字符推理、正文为零）。为避免客户端踩到该退化形态，出站请求
统一剥除思考开关。

该默认值安全但绝对：它同时把**给了足够预算**的调用方一并挡在门外，而这类调用方本来是能
正常思考的（`max_tokens: 60000` 实测推理与正文依次产出）。设 `CNB2API_ALLOW_THINKING=1`
即可显式开启，并由调用方自行保证预算。未携带思考开关的请求在两种设置下行为完全一致。

---

## 常见问题 (FAQ)

**Q: 既然上游是 DeepSeek，为什么模型列表有 glm 和 kimi？**  
A: `/v1/models` 是**自发现**的：CNB 网关没有列表接口，所以反代从每一次补全响应里嗅探网关回带的真实模型 id（例如 `deepseek-v4.1-flash`）并对外暴露，且持久化到磁盘跨重启保留。`PROXY_MODELS` 只是首个请求发生前的**兜底**列表——它保证各类客户端默认预设开箱即用，你也可以随时把它固化成 `/v1/models` 实际返回过的值。

**Q: 原生函数/工具调用（Tool Calls）支持怎么样？**  
A: 完整原生支持。流式模式下支持 `input_json_delta` 增量合并，非流式模式下忠实聚合出标准的 `tool_calls` 结构。

**Q: 是否违反 CNB 用户条款？**  
A: 本项目完全运行在你的合法工作区中，调用官方公开文档中的正规端点，使用平台签发的流水线 Token，扣除的是你组织的自有配额。不逆向、不破解、不涉及灰产爬虫。

---

## 许可

MIT © [dengyie](https://github.com/dengyie/cnb2api)
