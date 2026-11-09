<!-- markdownlint-disable-file MD033 MD045 -->
<div align="center">

# CNB2API

**将 CNB 云原生工作区内网模型转化为高可用生产级 OpenAI 与 Anthropic 双协议网关**

[![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933.svg?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![OpenAI](https://img.shields.io/badge/Protocol-OpenAI-412991.svg?style=flat-square&logo=openai&logoColor=white)](https://platform.openai.com/)
[![Anthropic](https://img.shields.io/badge/Protocol-Anthropic%20Claude-D97706.svg?style=flat-square&logo=anthropic&logoColor=white)](https://docs.anthropic.com/)
[![Tests](https://img.shields.io/badge/tests-103%20passed-brightgreen.svg?style=flat-square)]()

[English](./README.md) · [简体中文](./README.zh-CN.md) · [核心特性](#核心特性) · [系统架构](#系统架构与自愈全景) · [快速上手](#快速上手) · [Claude Code 直连](#claude-code-直连集成) · [终端看板](#终端额度看板)

<br>

<p align="center">
  <b>彻底打破云原生工作区内网隔离屏障与流水线临时凭据过夜失效的技术阻碍。</b><br>
  将原本深锁于容器内部的 DeepSeek 补全数据流，以零运行时外部依赖的形式转换为工业级双协议 API。<br>
  原生支持 Claude Code 零配置直连与出站防拦截改写，具备 v5.2 双保险域名自愈同步机制与实时 ANSI 终端额度看板。
</p>

</div>

---

## 痛点与架构对比

CNB 官方每月向每个认证组织免费赠送 500 至 1,166 点 AI Credits 与 1,600 核时算力。配合官方 Prompt Cache 缓存优惠，折算每月可用额度高达约 2 亿 DeepSeek Tokens。然而，该核心端点严格受限于工作区内网隔离策略，依赖短期流水线 Token，且容器每日自动回收：

| 评估维度 | CNB2API 网关（本项目） | 社区逆向网页抓取方案 | 直接公网访问 |
| :--- | :--- | :--- | :--- |
| **每月免费可用量** | 最高约 2 亿 DeepSeek Tokens（1,166 Credits + 30 倍缓存） | 极不稳定，极易遭遇风控拦截 | 0（受网络隔离策略拦截） |
| **网络可达性** | 内网反代 + 动态中继，公网稳定访问 | 依赖无头浏览器与住宅代理池 | 遭遇 HTTP 403（网络策略拦截） |
| **鉴权凭据流转** | 流水线即时签发临时 `CNB_TOKEN`（零静态凭证泄露风险） | 逆向抓取前端 Cookie 与 Session | 个人令牌直接 403（仅限流水线环境） |
| **双协议支持** | 完整 OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`)| 仅部分模拟基础文本接口 | 无 |
| **Claude Code 直连** | 原生无缝直连（内置 11128 计费头与指纹中性化规避） | 不支持（缺少工具调用能力，触发即封） | 不支持 |
| **函数与工具调用** | 原生透传（流式增量 `input_json_delta` 组装与完整聚合） | 不支持 | 无 |
| **外部运行依赖** | 真正零外部依赖（纯 Node.js 22+ 内置标准库，毫秒级冷启） | 庞大依赖包（Chromium、Puppeteer、Python） | 无 |
| **高可用自愈能力** | v5.2 双保险自愈（内网定时流水线 + 外部看门狗保活） | 页面 DOM 一旦变更即报废 | 无 |
| **额度审计看板** | 内置 CLI 看板（`cnb2api-quota`）+ `/usage` 对账端点 | 黑盒运行，无法统计真实损耗 | 仅能在网页控制台深处查看 |

---

## 核心特性

| 模块 | 特性亮点 | 技术实现与工程优势 |
| :--- | :--- | :--- |
| **双协议栈引擎** | OpenAI + Anthropic Claude 深度兼容 | 全面映射 `/v1/chat/completions` 与 `/v1/messages`，支持双向流式转换、思考块透传与使用量对账。 |
| **出站中性化防线** | 三层反拦截误报规避机制 | 智能改写客户端计费头与特征短语，将 `developer` 规范化为 `system`，并在遭遇 400/11128 时自动执行阶梯重试。 |
| **极简零依赖内核** | 最小化受攻击面与秒级启动 | 严格基于 Node.js 22+ 原生模块构建（`fetch`、`ReadableStream`、`crypto.timingSafeEqual`），免去 `npm install`。 |
| **v5.2 自愈架构** | 动态域名自动跟随与零凭据保留 | 工作区启动时读取临时 `CNB_TOKEN`，将新子域名上报至 `/ops/register`，Nginx 自动热加载 upstream（约 2 分 13 秒恢复）。 |
| **防休眠看门狗** | 应对 CI 平台定时任务休眠 | 外部独立看门狗脚本监控公网端点，检测到平台休眠时自动调用 OpenAPI 唤醒工作区。 |
| **原生工具调用** | 忠实还原流式函数调用协议 | 毫秒级重组流式 `input_json_delta` 分片，非流式模式下精准聚合输出标准 `tool_calls`。 |
| **动态模型自发现** | 自适应追踪上游网关模型代号 | 从上游补全响应中实时嗅探并持久化真实模型标识（如 `deepseek-v4.1-flash`），动态注册至 `/v1/models`。 |
| **终端额度看板** | 命令行即时审计多维资源消耗 | 随包附带 `cnb2api-quota` CLI，以彩色 ANSI 进度条直观呈现 AI Credits、开发核时与 CI 算力配额。 |

---

## 系统架构与自愈全景

```text
客户端 (OpenAI 客户端 / Claude Code / API 聚合网关)
  │  https://ai.example.com/v1 (固定公网域名，自建 Nginx 中继)
  ▼
https://<动态子域名>-9001.cnb.run (CNB 端口代理，每次开机通过 /ops/register 自动同步)
  │
  ▼
node src/server.mjs (工作区内网 9001 端口，cnb2api 反代服务)
  │  Bearer CNB_TOKEN (平台流水线自动即时签发，CNB 内网)
  ▼
https://api.cnb.cool/<org>/<repo>/-/ai/chat/completions (官方 AI 核心端点)
```

### 自愈生命周期闭环

1. **定时探测自愈**：平台内网流水线定时执行探活任务，检测到工作区处于停止状态时自动发起启动请求。
2. **开机自动注册**：工作区开机后执行启动脚本，提取当前分配的子域名并 POST 发送至中继的 `/ops/register` 端点，Nginx 自动重载 upstream 配置。
3. **外部防休眠兜底**：外部独立看门狗脚本（`cnb-watchdog.sh`）持续巡检固定公网域名，有效防范因平台长期无提交导致的定时任务休眠。

---

## 快速上手

### 1. 部署指引

1. **私有 Fork 仓库**：在 CNB 平台上将本项目 Fork 为**私有仓库**。
2. **配置访问密钥**：在仓库的 `.cnb.yml` 文件中，于 `env:` 块配置自定义的 `PROXY_KEY`（例如通过 `openssl rand -hex 24` 生成）。
3. **启动云端工作区**：在网页端点击“启动云原生开发”。初始化完成后，控制台将输出服务地址 `PROXY_URI=https://<子域名>-9001.cnb.run`。

### 2. curl 调用验证

```bash
curl https://<子域名>-9001.cnb.run/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

---

## Claude Code 直连集成

无需借助任何第三方中转，即可将 Anthropic Claude Code 直接接入 CNB DeepSeek 补全端点：

```bash
export ANTHROPIC_BASE_URL="https://ai.example.com"
export ANTHROPIC_AUTH_TOKEN="your-proxy-key"
export ANTHROPIC_MODEL="deepseek-v4.1-flash"

claude -p "请用简练的技术语言解释分布式系统中的 Paxos 共识算法。"
```

---

## 额度与成本测算：如何实现每月 2 亿 Tokens

基于长期线上实测的真实计费数据：

| 资源配额 | 每月免费总量 | 消耗与折算说明 |
| :--- | :--- | :--- |
| **AI Credits** | 基础 500 点，完成新手进阶后最高达 1,166 点 | 每一次补全请求均回传精确扣除的 Credit。结合 Prompt Cache 最高可换算约 2 亿 Tokens/月。 |
| **算力核时** | 1,600 核时（开发与流水线共享池） | 双核工作区整月 30 天 7x24 小时不间断运行仅消耗 1,440 核时，完全落在免费配额内。 |

### 容量测算公式

1. **未缓存基准消耗**：调用 `deepseek-v4.1-flash` 时，全新未命中的 9,000 Tokens 请求约消耗 0.39 Credit（折算约 2.3 万 Tokens / Credit）。
2. **Prompt Cache 缓存折扣**：当请求前缀命中缓存后，单次请求成本降至约 0.01 Credit（享受 30 倍折扣，折算约 70 万 Tokens / Credit）。
3. **典型混合场景推导**：在编程辅助、Claude Code 与多轮 Agent 循环等典型上下文高复用场景下，假设上下文缓存命中率为 90%：
   $$\text{综合成本} = 10\% \times 1 + 90\% \times \frac{1}{30} \approx 13\% \text{ 原价} \implies \approx 17.7\text{ 万 Tokens / Credit}$$
   $$\text{每月总额度} = 1,166\text{ Credits} \times 17.7\text{ 万 Tokens} \approx \mathbf{2.06\text{ 亿 Tokens / 月}}$$

---

## 终端额度看板

无需打开浏览器即可在终端实时审计配额余额与结算明细：

```bash
npm run quota
# 或执行: npx cnb2api-quota
```

```text
  CNB Quota Balance  org-slug

  Credits  ███████▋───────────────────  32%   320.0 / 1,000.0 cr
  Dev      ██████▏─────────────────────  25%   406.4 / 1,600.0 core-h
  CI       █▋──────────────────────────   8%    13.0 / 160.0 core-h

  In-flight (unsettled): 12.0 cr, 0.8 core-h
  Remaining balance:     680.0 cr as of 2026-11-09 08:30:00 UTC
```

- `cnb2api-quota --line`：单行精简模式，便于集成到 Shell 提示符或状态栏。
- `cnb2api-quota --json`：标准 JSON 格式输出，便于外部自动化监控系统收集。

---

## 环境变量与配置项参考

| 环境变量 | 默认值 | 配置说明 |
| :--- | :--- | :--- |
| `PROXY_KEY` | 无（必填） | 客户端通过 Bearer Token 或 `x-api-key` 请求反代网关时的校验密钥。 |
| `CNB_TOKEN` | 无（必填） | CNB 平台内网鉴权令牌，由流水线环境自动注入。 |
| `CNB_REPO_SLUG` | 平台内置 | 上游目标路由格式 `org/repo`，由平台流水线自动填充。 |
| `PROXY_MODELS` | `deepseek-v4.1-flash,glm-5.3-flash,kimi-k3` | 初始兜底模型列表，在尚未嗅探到真实上游标识前用于 `/v1/models`。 |
| `PROXY_MODELS_STATE` | `models-state.json` | 已发现模型名称的持久化存储路径，支持跨工作区重启保留。 |
| `PROXY_PORT` | `9001` | 反代网关本地监听端口。 |
| `PROXY_UPSTREAM_TIMEOUT_MS`| `15000` | 上游建立连接与首字节响应超时时间（毫秒）。 |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | 长连接流式事件空闲超时看门狗阈值（毫秒）。 |
| `PROXY_NEUTRALIZE` | `1` | 出站客户端指纹中性化开关。设为 `0` 时原样透传出站报文。 |
| `PROXY_NEUTRALIZE_AGGRESSIVE`| `0` | 激进品牌词打散开关。 |
| `PROXY_BLOCK_RETRY` | `1` | 11128 阶梯式自动重试：被拒后依次尝试折叠 System 提示词及文本打散。 |
| `PROXY_ENSURE_SYSTEM` | `1` | 自动将 `developer` 角色规范化为 `system` 并将中途提示词前置。 |
| `PROXY_SYNTHETIC_SYSTEM` | `0` | 当请求缺少 System 角色时补充中性占位 System（默认关闭）。 |
| `CNB2API_ALLOW_THINKING` | `0` | 设为 `1` 时将思考开关透传至上游变体，并自动抬升 `max_tokens` 防止推理吃光正文预算。 |
| `CNB2API_THINKING_MIN_TOKENS` | `32768` | 透传思考时自动抬升 `max_tokens` 的下限。 |
| `CNB2API_THINKING_MAX_TOKENS` | `64000` | 自动抬升的上限；客户端自己给得更大的预算不会被压低。 |
| `REGISTER_URL` | 无（可选） | 动态域名自注册中继端点地址（`/ops/register`）。 |
| `REG_TOKEN` | 无（可选） | 动态域名自注册通信鉴权凭据。 |

---

## 常见问题解答

**为什么初始模型列表包含 GLM 与 Kimi？**  
`/v1/models` 端点采用自主动态嗅探机制。由于上游网关未提供独立的模型列表查询接口，反代通过嗅探每次补全响应中的实际模型名称动态沉淀。初始兜底列表旨在确保各类客户端在首次连接时可正常列出备选项。

**原生工具调用与流式 Function Calling 是否得到支持？**  
全面支持。流式模式下支持 `input_json_delta` 分片的实时还原与组装；非流式模式下精确返回标准的 OpenAI `tool_calls` 结构体。

**出站中性化机制如何化解 11128 错误？**  
上游网关对 `system` 与 `assistant` 提示词内容执行严格的客户端指纹模糊匹配。CNB2API 通过三层机制有效应对：首先对已知特征短语执行等价改写并对特定品牌词插入零宽空格；其次将新型 `developer` 角色平滑归一为 `system`；最后在遭遇 HTTP 400/11128 拦截时，触发自动重试阶梯将系统提示词折叠至用户首条消息。

**为什么模型不思考 / 看不到推理内容？**  
思考开关（`reasoning_effort`、`thinking`、`enable_thinking` 等）默认会被剥除：上游 thinking 变体把推理阶段也计入 `max_tokens`，预算小时推理吃光配额、正文一个字都出不来（`finish_reason=length`、content 为空）。设置 `CNB2API_ALLOW_THINKING=1` 即可放行，代理会同时把 `max_tokens` 抬到 `CNB2API_THINKING_MIN_TOKENS`（默认 32k），并把 Anthropic 的 `thinking.budget_tokens` 折进该预算；客户端自己给得更大的预算原样保留。不带思考开关的请求不受影响。

**使用本项目是否违反平台规范？**  
完全合规。CNB2API 完全运行在用户自有合规工作区中，调用公开的平台端点，使用平台签发的流水线临时凭证，严格在组织已分配的合法配额内运行。

---

## 参与贡献与许可证

欢迎提交 Issue 与 Pull Request。在提交改动前，请确保全量测试套件执行通过：

```bash
node --test test/*.test.mjs
```

本项目采用 [MIT License](LICENSE) 开源协议。
