<div align="center">

# cnb2api

**把 CNB 免费 AI 额度,变成一个标准的 OpenAI 兼容 API。**

[![test](https://github.com/dengyie/cnb2api/actions/workflows/test.yml/badge.svg)](https://github.com/dengyie/cnb2api/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · 简体中文

</div>

CNB 给每个实名组织每月一份免费 AI 额度——但它只能在 CNB 云工作区**内部**
调用(端点需要流水线 `CNB_TOKEN` 和 CNB 内网)。**cnb2api** 在工作区里跑一个
极小的反向代理,把它变成一个稳定的 `https://…/v1/chat/completions` 地址,
任何 OpenAI 客户端都能从任何地方调用。

- 🔓 **生而合规。** 只走**官方文档化**的工作区 AI 端点,用 CNB 自己签发的
  流水线 `CNB_TOKEN`——不逆向前端接口、不抓匿名会话、不跟平台规则对着干。
- ♻️ **扛得住每天回收。** CNB 过夜回收工作区、子域名每次重启都变。一个保活
  循环自动自愈,客户端始终用同一个固定 URL、完全无感——在易逝的机器上攒出
  一个常年在线的端点。
- 🪶 **零依赖。** 只用 Node 22+ 内置能力(`fetch` / `AbortSignal` / streams),
  测试跑内置的 `node:test`。没有任何 `npm install`。
- 📊 **终端里看额度。** 一条命令展示 AI credits 与核时——CNB 生态里独一份的
  额度工具。

## 工作原理

```
client ──https://ai.example.com/v1──▶ 固定域名(自建 relay / nginx)
                                        │  /ops/register 自动改写 upstream map
                                        ▼
                          https://<子域名>-9001.cnb.run   (CNB 端口代理)
                                        │
                                        ▼
                          node src/server.mjs   (本代理,跑在工作区里)
                                        │  Bearer CNB_TOKEN,仅 CNB 内网可达
                                        ▼
       https://api.cnb.cool/<org>/<repo>/-/ai/chat/completions   (CNB AI 端点)
```

`ai.example.com`、`<org>/<repo>`、端口 `9001` 都是**占位符**——换成你自己的。
固定域名是可选的;不用的话,直接用构建日志里那个
`https://<子域名>-9001.cnb.run/v1`。

### 在一台每天都死的机器上保持在线

工作区被当作**牲口,而非宠物**(cattle, not a pet)。一条 cron 流水线加一个
小中继,把一台每晚被回收的机器,变成一个像高可用 VPS 一样的端点:

```
每 5 分钟(cron 流水线)               每次开机                       你的中继
┌─────────────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ 工作区还活着吗?             │   │ start.sh 运行 →      │   │ nginx upstream map  │
│  活着 + 域名正常 → 不动     │──▶│ POST /ops/register   │──▶│ 改指到最新的        │
│  域名死了       → 重注册    │   │ (当前子域名)         │   │ 子域名              │
│  没活着         → 拉起      │   └──────────────────────┘   └─────────────────────┘
└─────────────────────────────┘
```

- **自愈**——cron 拉起死掉的工作区;固定域名两次健康检查失败触发重注册。
  全程无人干预。
- **地址固定、后端可动**——客户端永远只看到一个 URL;工作区回收后,中继几
  分钟内改指到新子域名。实测一次真实回收演练,完整恢复(检出 → 新工作区 →
  重注册)耗时 **~2 分 13 秒**。
- **磁盘上不留长效令牌**——被回收的工作区什么都不带,下次开机按设计重新铸造
  一次性 `CNB_TOKEN`。你的 `PROXY_KEY` 和 `REG_TOKEN` 放在私有密钥仓,构建时
  才注入。

这是**服务级**高可用,不是实例级:稳定 URL 与可用代理自动扛过回收。代价是
每次恢复的几分钟中断——对一个个人网关来说,零额外基础设施成本下这个取舍很
难被超越。设计细节见 [docs/DESIGN.md](docs/DESIGN.md)。

## 功能

- **OpenAI 兼容**——`/v1/chat/completions`(流式 SSE + 非流式)、`/v1/models`、
  `/health`。原生**函数/工具调用**原样透传。
- **忠实的非流式聚合**——把 SSE 流里的 `content`、增量 `tool_calls`、
  `reasoning_content`、`usage`、`finish_reason` 重组成一个完整的
  `chat.completion` 对象。
- **生产级加固转发**——连接超时、流级空闲看门狗、背压处理、双向取消(客户端
  断开会中止上游,不再为已放弃的请求烧额度)。
- **时序安全的 key 鉴权**——配滑动窗口失败限流(滥用回 429)。
- **额度看板 CLI**——`cnb2api-quota` 直连 CNB charge 接口,见[下文](#额度看板cli)。

## 快速开始 —— 部署到 CNB

**完整流程见 [docs/SETUP.md](docs/SETUP.md)**——从零到一个验证过的端点约 10
分钟(建代码仓 → 带 `allow_slugs` 的密钥仓 → 改 `.cnb.yml` → 启动工作区 →
端到端验证,附排障表)。

你需要:一个 org 已开通 AI 额度的 CNB 账号,以及你自己的模型 id(填
`PROXY_MODELS`)。想要重启自动跟随的可选固定公网域名,按
[docs/DEPLOY.md](docs/DEPLOY.md) 部署 nginx 中继。每个配置项见
[`.env.example`](.env.example) 与下方[配置](#配置)表。

## 你实际能得到什么

这套方案背后有两份相互独立的免费额度:**AI credits** 付推理费,**核时** 付
反代算力费。以下数字全部来自我们自己长期在线的部署——是实测,不是营销。

| 额度 | 每月免费配额 | 用来付什么 |
|---|---|---|
| **AI credits** | 基础 **500**,完成 *hello-cnb* 闯关后达 **1,166** | 每一次 AI 请求——每个响应的 `usage` 都精确上报本次消耗的 `credit` |
| **算力核时** | **1,600 核时**(dev + CI 共享池) | 跑反代的工作区,外加保活流水线 |

> 500 基础额度随实名组织发放;完成 CNB 官方 *hello-cnb* 闯关(「天才程序员」
> 徽章)会追加每月浮动奖励(我们账号合计 1,166/月)。你自己的总额以账号实际
> 状态为准。

**Credits → tokens(实测)。** 上游在每个响应的 `usage` 里直接返回 `credit`
字段,消耗是精确值。对 `deepseek-v4-flash` 的实测:

- 全新(未缓存)约 9,000 tokens 的请求花费约 **0.39 credit**——约
  **23,000 tokens / credit**,多次一致。
- 相同 prompt 命中 CNB 的 prompt 缓存后降到 **~0.01 credit**——缓存部分约为
  原价的 **1/30**。

所以综合单价取决于你的缓存命中率。按 **90% 命中率**(固定 system prompt、
Agent 循环反复读同一段上下文的场景)算,平均成本是
`10%×1 + 90%×(1/30) ≈ 13%` 的原价——约 **17.7 万 tokens/credit**,1,166
credits 约合 **2 亿 tokens/月**。别把任何单一数字当承诺:用下方的
[额度 CLI](#额度看板cli) 盯你自己的真实消耗。

**核时 → 在线时长。** `runner.cpus: 2` 的工作区每天烧 **48 核时**;整月 30 天
不间断 = **1,440 核时**,在 **1,600** 池子之内——不需要为省核时而关停反代。
5 分钟一次的保活单月只多花几个核时。CNB 单次会话上限 18 小时,运行超 8 小时
的工作区在 04:00–06:00(UTC+8)窗口会被回收,保活循环负责立刻拉回来。

## 模型

`/v1/models` 展示的就是你在 `PROXY_MODELS` 里列的清单。我们账号上,CNB 网关
当前暴露三个 id——而且当前都路由到同一个上游模型:

| 模型 id | 说明 |
|---|---|
| `deepseek-v4-flash` | 当前实际应答的模型。 |
| `glm-5.3-flash` | 可作为 id 调用,但被路由到 `deepseek-v4-flash`(响应的 `model` 字段可印证)。 |
| `kimi-k3` | 同上——当前同样路由到 `deepseek-v4-flash`。 |

额外的名字只是为了客户端兼容。`PROXY_MODELS` 请按你自己账号实际暴露的清单来
设。流式与非流式请求、完整 `usage` 聚合(含 `credit`)、原生 `tools` 调用均已
对线上端点实测验证。上下文窗口由上游决定且官方未文档化,我们不引用无法核实的
数字。

## 到处都能用

端点说的是标准 OpenAI chat completions,凡是支持自定义 base URL 的都能直接
用。把 base URL 指到你的固定域名(`https://ai.example.com/v1`),API key 填你
的 `PROXY_KEY`:

- **聊天客户端**——LobeChat、Cherry Studio、Open WebUI、NextChat……
- **编码 Agent / SDK**——Codex CLI、官方 `openai` SDK,或任何 OpenAI 兼容工具链。
- **curl**——见[本地开发](#本地开发)。

## 额度看板(CLI)

CNB 的额度和核时只在网页控制台深处能看。`cnb2api-quota` 把它变成终端里的一条
命令:

```bash
npm run quota                 # 或: npx cnb2api-quota
```

```
  ◆ CNB quota  your-org

  Credits  ███████▋───────────────────  32%   320.0 / 1,000.0 cr
  Dev      ██████▏─────────────────────  25%   406.4 / 1,600.0 core-h
  CI       █▋──────────────────────────   8%   13.0 / 160.0 core-h

  in-flight (not yet settled): 12.0 cr, 0.8 core-h

  remaining credits: 680.0 cr   as of 2026-01-15 08:30:00 UTC
```

红黄绿进度条(随消耗从绿到红)、千分位、以及已预留但尚未结算的 in-flight
额度。另有两种输出模式:

```bash
cnb2api-quota --json          # 给脚本用的规整快照
cnb2api-quota --line          # 状态栏 / shell 提示符的单行
```

它直连 CNB charge 接口(`/-/charge/quota` + `/-/charge/volume`),所以**反代
工作区没开机也能查**,且任何能看到 org 账单的令牌都行——不需要流水线令牌的
特殊权限。org 取自 `CNB_REPO_SLUG`,或用 `--org <org>` / `QUOTA_ORG` 覆盖。

## 本地开发

跑测试(mock 上游,不打真实 API):

```bash
node --test
```

用测试钩子把上游指到任意 OpenAI 风格服务,单机跑反代:

```bash
PROXY_KEY=my-secret \
CNB_TOKEN=dummy \
CNB_REPO_SLUG=your-org/ai-proxy \
UPSTREAM_OVERRIDE=http://127.0.0.1:8080 \
node src/server.mjs
```

```bash
curl http://127.0.0.1:9001/v1/chat/completions \
  -H "Authorization: Bearer my-secret" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## 配置

| 环境变量 | 默认值 | 用途 |
|-----|---------|---------|
| `PROXY_KEY` | —(必填) | 客户端必须携带的 Bearer key。无默认值;缺失拒绝启动。 |
| `CNB_TOKEN` | —(必填) | 上游令牌;由 CNB 流水线阶段自动注入。 |
| `CNB_REPO_SLUG` | `CNB_BUILD_REPO` | 拼上游 URL 用的 `org/repo`。工作区内自动填充。 |
| `PROXY_MODELS` | `deepseek-v4-flash,glm-5.3-flash,kimi-k3` | `/v1/models` 展示的模型 id 列表。 |
| `PROXY_PORT` | `9001` | 监听端口。 |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `15000` | 上游连接 / 首字节超时。 |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | 流级空闲看门狗。 |
| `REGISTER_URL` | —(可选) | 自注册的 relay `/ops/register` 地址。 |
| `REG_TOKEN` | —(可选) | 自注册共享密钥。 |
| `QUOTA_ORG` | —(可选) | 额度 CLI 查询的 org,与 `CNB_REPO_SLUG` 不同时使用。 |
| `UPSTREAM_OVERRIDE` | — | 仅测试:把上游指到本地 mock。 |

## FAQ

**和 GitHub 上那些匿名 CNB 代理有什么区别?**
根本区别。那些项目包装的是 CNB 给匿名网页访客用的前端 NPC 聊天接口——抓 CSRF
令牌、轮转会话池、网站一改版就得重新逆向协议。脆弱、无账号,也明显不是平台
本意。cnb2api 走的是**官方工作区 AI 端点**:文档化路径、你自己 org 的额度、
完整 `tools` 支持、用量记录在你自己账号上。花的是你自己的额度,而不是平台的
耐心——UI 改版也照样能用。

**原生工具调用能用吗?**
能。请求走官方端点、带你的流水线令牌,所以 `tools` / `tool_calls` 原样透传
——不需要任何提示词注入的绕行手段。

**实现了哪些 API 端点?**
`/v1/chat/completions`(SSE 流式 + 非流式)、`/v1/models`、`/health`。没有
embeddings/audio/files——上游本身也不提供。

**支持 Anthropic 格式的客户端吗?**
不直接支持——这是个 OpenAI 兼容 shim。用说 OpenAI 格式的客户端即可(大多数
聊天客户端和 Agent 都是)。

**跑起来要花什么成本?**
代码是 MIT 免费的。你花的是 CNB 额度:每次请求的 AI credits,加上保活撑开
工作区期间的核时(2 核约 48 核时/天——预算算法见上文)。

**这和 CNB 官方有关联吗?**
没有。独立的个人自用项目。请遵守平台服务条款。

## 许可

MIT——见 [LICENSE](LICENSE)。

> 与 CNB 无隶属关系。这是一个独立的、个人自用的兼容 shim。请遵守 AI 服务商
> 与平台的服务条款。

如果 cnb2api 帮你省下了一笔付费 API 订阅,欢迎点个 ⭐——能帮到更多 CNB 用户
发现它。
