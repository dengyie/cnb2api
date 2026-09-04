<div align="center">

# cnb2api

**把 CNB 免费赠送的 AI 额度,变成一个普通 OpenAI 兼容接口。**

[![test](https://github.com/dengyie/cnb2api/actions/workflows/test.yml/badge.svg)](https://github.com/dengyie/cnb2api/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · 简体中文

</div>

把 [CNB](https://cnb.cool) 云工作区的**内网 AI 端点**转成标准
**OpenAI 兼容 API**——100% 跑在云上,本地零依赖,自带自愈固定公网地址,
每天被平台回收也不掉线。不逆向、不蹭匿名接口:这是使用你额度的「账面上」
正路。

CNB 内置的 AI 额度只能在云工作区内部访问(端点要求流水线 `CNB_TOKEN` 和
CNB 内网)。本项目在那个工作区**里面**跑一个小小反向代理,把它暴露成
`https://.../v1/chat/completions`,任何 OpenAI 客户端都能直接对接。

> Node 22+ · **零 npm 依赖**(原生 `fetch` / `AbortSignal` / streams)·
> 测试用内置 `node:test` 运行器。

> [!NOTE]
> **生而合规。** cnb2api 只对接**官方工作区 AI 端点**,使用 CNB 自己签发的
> 流水线 `CNB_TOKEN`——没有逆向前端的接口,没有匿名会话抓取,不与平台的
> 社区规定起任何冲突。

## 为什么需要 cnb2api?

CNB 送的 AI 额度很可观,但三道墙把它锁在工作区里:

| 痛点 | cnb2api 的解法 |
|---|---|
| AI 端点只应答 CNB 内网请求 | 一个小小的反向代理**跑在工作区内部**,替你转发 |
| `CNB_TOKEN` 每次流水线运行才生成,没法长期保存 | keepalive 定时任务每次运行铸造新令牌;你的密钥只放在私有仓 |
| 工作区子域名每次重启都会变 | 工作区开机自动上报地址;你的固定域名自动跟随 |
| 灰色手段的同类项目随平台一改就崩,原生工具调用还会被 403 | 我们走**官方文档端点**——不逆向前端,完整支持 `tools`,平台改版也与我们无关 |

最终得到一个从任何地方都能用的稳定 `https://…/v1` 地址——笔记本、CI、
托管应用,统统可用。而且因为用的是你自己 org 的端点和自己的额度,一切
都在平台服务条款之内。

## 一次性机器上的高可用

CNB 会回收云工作区(比如每天夜里),每次重启子域名都会变。cnb2api 不跟
平台对抗,而是把工作区当**牲口而非宠物**养——让一台天天「死」的机器,
变成一台像高可用 VPS 一样常年在线的端点:

```
每 5 分钟(cron 流水线)              每次开机                        你的 VPS / 中继
┌─────────────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ 工作区活着吗?               │   │ start.sh 执行 →      │   │ nginx upstream map  │
│  活着 + 域名正常 → 不动      │──▶│ POST /ops/register   │──▶│ 改写到最新子域名     │
│  域名死了         → 重新注册 │   │ (当前子域名)         │   │                     │
│  没活着           → 拉起     │   └──────────────────────┘   └─────────────────────┘
└─────────────────────────────┘
```

- **自愈**:keepalive 定时任务发现工作区死亡就拉起;固定域名连续两轮健康
  检查失败就触发重新注册。全程无人值守。
- **地址固定,后端漂移**:客户端永远只看到 `https://ai.example.com/v1`;
  中继在工作区被回收后的几分钟内指向新子域名。
- **零长效凭据暴露**:被回收的工作区磁盘上不留任何令牌——下次开机按设计
  铸造全新的 `CNB_TOKEN`。

结果:每日重启变成一件无感的小事。客户端 URL 不变、key 不变,根本察觉
不到发生过回收。

## 功能

- **生而合规**:只走**官方、有文档的工作区 AI 端点**,用流水线
  `CNB_TOKEN`——不逆向前端接口、不搞匿名会话池、不碰社区规定的灰色地带。
  你的额度、你的 org、账面清清楚楚。
- **OpenAI 兼容**:`/v1/chat/completions`(流式 SSE + 非流式)、
  `/v1/models`、`/health`。
- **终端里的额度看板——CNB 生态里独此一家**:一条命令展示 AI credits 和
  核时,红黄绿进度条——额度烧完之前心里有数。即装即用:`cnb2api-quota` /
  `npm run quota`,同样零依赖。
- **忠实的非流式聚合**:把上游 SSE 流重新拼装成完整的 `chat.completion`——
  `content`、增量 `tool_calls`、`reasoning_content`、`usage`、
  `finish_reason` 一个不丢。
- **生产级转发加固**:连接超时、流级空闲看门狗、背压处理、双向取消——
  客户端断开会立刻 abort 上游,废弃请求不再白烧额度。
- **Timing-safe 密钥鉴权**,滑动窗口失败限流(被刷自动 429)。
- **一次性机器上的高可用**:CNB 每天回收工作区、子域名每次重启都变——
  keepalive 定时任务拉起死亡的工作区、工作区开机自动上报新地址、小中继
  自动把固定域名指过去。客户端只用一个稳定 URL,完全感知不到回收。等于
  在一台易逝的机器上,攒出一台常年在线的 VPS。
- **磁盘上不留长效令牌**:keepalive 流水线用一次性 `CNB_TOKEN`;API key
  和中继令牌放在私有密钥仓,通过 `imports:` 注入,绝不提交进本仓。

## 架构

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

Keepalive(见 [docs/DESIGN.md](docs/DESIGN.md)):定时流水线保证工作区存活
(每次铸造新的短时效 `CNB_TOKEN`);工作区开机把子域名上报给中继;中继只
跟随当前地址。

上文 `ai.example.com`、`<org>/<repo>`、`9001` 都是**占位符**——换成你自己的。

## 快速开始 —— 部署到 CNB

**从这里开始:[docs/SETUP.md](docs/SETUP.md)**——从零完整走一遍
(建代码仓 → 带 `allow_slugs` 的密钥仓 → 改 `.cnb.yml` → 启动工作区 →
端到端验证,附排障表)。已有带 AI 额度的 CNB 账号的话,全程约 10 分钟。

先决条件一句话:一个 org 已开通 AI 额度的 CNB 账号,外加知道你的模型名
(`PROXY_MODELS`)。额度账:2 核常驻工作区 ≈ 48 核时/天,对照 CNB 免费的
~1600 核时/月。

需要可选的固定公网域名(`https://ai.example.com/v1`,重启自动跟随)的话,
按 [docs/DEPLOY.md](docs/DEPLOY.md) 部署 nginx 中继。不部署的话,用构建
日志里打印的 `https://<子域名>-9001.cnb.run/v1`(每次重启会变)。

所有配置项见 [`.env.example`](.env.example)。

## 额度看板(CLI)

CNB 每月送 AI credits 和免费核时,但只在网页控制台里能看。`cnb2api-quota`
把它变成终端里的一条命令:

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

红黄绿进度条(越烧越红)、千分位、以及"进行中"的冻结额度(已预留、尚未
结算)。另有两个给机器看的输出模式:

```bash
cnb2api-quota --json          # 归一化快照,给脚本用
cnb2api-quota --line          # 单行摘要,给状态栏 / shell 提示符用
```

它直连 CNB 官方 charge 接口(`/-/charge/quota` + `/-/charge/volume`),所以
**代理工作区没开机也能查**,而且不需要流水线 `CNB_TOKEN` 的特殊权限——
任何能看到 org 账单的令牌都行。org 取自 `CNB_REPO_SLUG`,也可用
`--org <org>` / `QUOTA_ORG` 覆盖。

## 到处都能用

端点就是普通的 OpenAI chat completions,凡是支持自定义 base URL 的客户端
直接填上固定域名(`https://ai.example.com/v1`)和 API key(`PROXY_KEY`)
就能用:

- **聊天界面**——LobeChat、Cherry Studio、Open WebUI、NextChat…
- **编码智能体 / SDK**——Codex CLI、官方 `openai` SDK,或任何
  OpenAI 兼容工具链。
- **curl**——示例见[本地开发](#本地开发)。

## 本地开发

跑测试(mock 上游,不打真实 API):

```bash
node --test
```

独立跑代理(用测试钩子把上游指到任意 OpenAI 风格服务):

```bash
PROXY_KEY=my-secret \
CNB_TOKEN=dummy \
CNB_REPO_SLUG=your-org/ai-proxy \
UPSTREAM_OVERRIDE=http://127.0.0.1:8080 \
node src/server.mjs
```

然后:

```bash
curl http://127.0.0.1:9001/v1/chat/completions \
  -H "Authorization: Bearer my-secret" -H "Content-Type: application/json" \
  -d '{"model":"model-a","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## 配置

| 环境变量 | 默认值 | 用途 |
|-----|---------|---------|
| `PROXY_KEY` | —(必填) | 客户端必须携带的 Bearer key。无默认值;缺失拒绝启动。 |
| `CNB_TOKEN` | —(必填) | 上游令牌;由 CNB 流水线阶段自动注入。 |
| `CNB_REPO_SLUG` | `CNB_BUILD_REPO` | 拼上游 URL 用的 `org/repo`。工作区内自动填充。 |
| `PROXY_MODELS` | `model-a,model-b,model-c` | `/v1/models` 展示的模型 id 列表。 |
| `PROXY_PORT` | `9001` | 监听端口。 |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `15000` | 上游连接 / 首字节超时。 |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | 流级空闲看门狗。 |
| `REGISTER_URL` | —(可选) | 自注册的 relay `/ops/register` 地址。 |
| `REG_TOKEN` | —(可选) | 自注册共享密钥。 |
| `QUOTA_ORG` | —(可选) | 额度 CLI 查询的 org,与 `CNB_REPO_SLUG` 不同时使用。 |
| `UPSTREAM_OVERRIDE` | — | 仅测试:把上游指到本地 mock。 |

## FAQ

**和 GitHub 上那些匿名 CNB 代理有什么区别?**
根本区别。那些项目包装的是 [CNB](https://cnb.cool) 给匿名网页访客用的前端
NPC 聊天接口:抓 CSRF 令牌、轮转会话池、网站一改版就得重新逆向协议——
脆弱、无账号,也明显不是平台本意。cnb2api 走的是**官方工作区 AI 端点**:
文档化的路径、你自己 org 的额度、完整 `tools` 支持、用量记录在你自己的
账号上。花的是你自己的额度,而不是平台的耐心——所以它能一直用下去。

**真的零依赖吗?**
是。运行时和测试只用 Node 22 内置能力——没有 `npm install`,
也没有需要审计的 `node_modules`。

**跑起来要花什么成本?**
代码 MIT 免费。你消耗的是 CNB 额度:每次请求花 AI credits,keepalive
保活工作区烧核时(2 核 ≈ 48 核时/天,预算账见
[SETUP.md](docs/SETUP.md))。

**实现了哪些 API 端点?**
`/v1/chat/completions`(SSE 流式 + 非流式)、`/v1/models`、`/health`。
没有 embeddings/音频/文件——上游本来也不提供。

**密钥放在哪?**
`PROXY_KEY` 和 `REG_TOKEN` 只存于你的私有密钥仓,构建时经 `imports:`
注入。任何长效 CNB 令牌都不会落盘。

**支持 Anthropic 格式的客户端吗?**
不直接支持——这是 OpenAI 兼容垫片。请用说 OpenAI 格式的客户端
(绝大多数聊天界面和智能体都支持)。

**原生工具调用能用吗?**
能。请求走官方端点、带你的流水线令牌,所以 `tools` / `tool_calls`
原样透传——不需要任何提示词注入的绕行方案。

**这算哪门子「高可用」?不就一个工作区吗。**
这是服务级的高可用,不是实例级的:服务(稳定 URL + 可用代理)能自动扛过
每天的工作区回收,恢复以分钟计、全程无人值守。和真正的多节点比,牺牲的
只是每次恢复期间几分钟的不可用——对一个个人 AI 网关来说,零额外基础设施
成本换这个可用性,很难有更划算的方案。

**和 CNB 官方有关系吗?**
没有。独立的个人用途项目——见[许可](#许可)下的声明。请遵守平台
服务条款。

## 许可

MIT——见 [LICENSE](LICENSE)。

> 与 CNB 无隶属关系。这是独立的、个人用途的兼容垫片。请遵守 AI 服务商
> 与平台的服务条款。

如果 cnb2api 替你省下了一笔 API 订阅费,欢迎点个 ⭐——让更多 CNB 用户
看到它。
