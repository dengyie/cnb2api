<div align="center">

# cnb2api

**Your CNB free AI credits, served over a plain OpenAI-compatible API.**

[![test](https://github.com/dengyie/cnb2api/actions/workflows/test.yml/badge.svg)](https://github.com/dengyie/cnb2api/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English · [简体中文](README.zh-CN.md)

</div>

Turn a [CNB](https://cnb.cool) cloud-workspace **in-network AI endpoint** into a
standard **OpenAI-compatible** API — 100% in the cloud, zero local dependencies,
with a self-healing fixed public address that shrugs off daily workspace
recycling. No reverse engineering, no anonymous endpoints: this is the
on-the-books way to use your credits.

CNB's built-in AI credits are only reachable from inside a CNB cloud workspace
(the endpoint requires a pipeline `CNB_TOKEN` and CNB-internal networking). This
project runs a tiny reverse proxy **inside** that workspace and exposes it as a
plain `https://.../v1/chat/completions` endpoint you can point any OpenAI client at.

> Node 22+ · **zero npm dependencies** (native `fetch` / `AbortSignal` / streams) ·
> tests use the built-in `node:test` runner.

> [!NOTE]
> **Above-board by design.** cnb2api talks only to the **official workspace AI
> endpoint** with the pipeline `CNB_TOKEN` CNB itself issues — no
> reverse-engineered front-end endpoints, no anonymous session scraping, and
> nothing that conflicts with the platform's community rules.

## Why cnb2api?

CNB ships generous free AI credits, but three things keep them locked inside
the workspace:

| The problem | What cnb2api does |
|---|---|
| The AI endpoint answers only on CNB-internal networking | a tiny reverse proxy runs **inside** the workspace and relays it |
| `CNB_TOKEN` is minted per pipeline run and can't be stored | a keepalive cron mints a fresh token on every run; your secrets stay in a private repo |
| The workspace subdomain changes on every restart | the workspace self-registers on boot; your fixed domain follows automatically |
| Gray-area mirrors of CNB's AI break on every platform change, and native tool calls get 403'd | we use the **documented, official endpoint** — no front-end reverse engineering, full `tools` support, nothing to break when the UI changes |

The result is one stable `https://…/v1` URL that works from anywhere — your
laptop, CI, or any hosted app. And because it's your own org's endpoint with
your own credits, it stays within the platform's terms of service.

## High availability on a throwaway machine

CNB recycles cloud workspaces (e.g. overnight), and every restart mints a new
subdomain. Instead of fighting that, cnb2api treats the workspace as
**cattle, not a pet** — and turns a machine that dies every day into an
always-on endpoint that behaves like a high-availability VPS:

```
every 5 min (cron pipeline)          on every boot                 your VPS / relay
┌─────────────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ workspace alive?            │   │ start.sh runs →      │   │ nginx upstream map  │
│  alive + domain OK → noop   │──▶│ POST /ops/register   │──▶│ repointed to the    │
│  domain dead      → re-reg  │   │ (current subdomain)  │   │ latest subdomain    │
│  not alive        → restart │   └──────────────────────┘   └─────────────────────┘
└─────────────────────────────┘
```

- **Self-healing**: the keepalive cron detects a dead workspace and restarts
  it; two consecutive failed health checks on the fixed domain trigger
  re-registration. No human in the loop.
- **Fixed address, moving backend**: clients only ever see
  `https://ai.example.com/v1`; the relay repoints to the fresh subdomain
  within minutes of a recycle.
- **Zero long-lived credentials at risk**: a recycled workspace carries no
  tokens on disk — the next boot mints a fresh `CNB_TOKEN` by design.

The result: daily restarts become a non-event. Your clients keep the same
URL, the same key, and never notice a recycle happened.

## Features

- **Above-board**: only the **official, documented workspace AI endpoint** with
  the pipeline `CNB_TOKEN` — no reverse-engineered front-end endpoints, no
  anonymous session pools, no community-rule gray areas. Your credits, your
  org, on the record.
- **OpenAI-compatible**: `/v1/chat/completions` (streaming SSE + non-streaming),
  `/v1/models`, `/health`.
- **Quota dashboard in your terminal — the only one in the CNB ecosystem**:
  one command shows AI credits and core-hours with traffic-light progress
  bars — know what's left before it runs out. Ships as `cnb2api-quota` /
  `npm run quota`, still zero dependencies.
- **Faithful non-stream aggregation**: reassembles `content`, incremental
  `tool_calls`, `reasoning_content`, `usage`, and `finish_reason` from the
  upstream SSE stream into a complete `chat.completion` object.
- **Production-hardened forwarding**: connect timeout, per-stream idle watchdog,
  backpressure handling, and two-way cancellation — a client disconnect aborts
  the upstream so you stop burning credits on an abandoned request.
- **Timing-safe key auth** with a sliding-window failure limiter (429 on abuse).
- **High availability on a throwaway machine**: CNB recycles workspaces daily
  and the subdomain changes on every restart — a keepalive cron restarts a dead
  workspace, the workspace self-registers its new URI on boot, and a small relay
  repoints your fixed domain automatically. Clients keep one stable URL and
  never notice a recycle. Effectively an always-on VPS built on an ephemeral box.
- **No long-lived tokens on disk**: the keepalive pipeline uses the per-run
  temporary `CNB_TOKEN`; your API key and relay token live in a private secrets
  repo injected via `imports:`, never committed here.

## Architecture

```
client ──https://ai.example.com/v1──▶ fixed domain (your relay / nginx)
                                        │  upstream map repointed by /ops/register
                                        ▼
                          https://<subdomain>-9001.cnb.run   (CNB port-proxy)
                                        │
                                        ▼
                          node src/server.mjs   (this proxy, in the workspace)
                                        │  Bearer CNB_TOKEN, CNB-internal only
                                        ▼
       https://api.cnb.cool/<org>/<repo>/-/ai/chat/completions   (CNB AI endpoint)
```

Keepalive (see [docs/DESIGN.md](docs/DESIGN.md)): a cron pipeline makes sure the
workspace is running (fresh short-lived `CNB_TOKEN`); the workspace self-registers
its subdomain to the relay on boot; the relay only follows the current address.

`ai.example.com`, `<org>/<repo>`, port `9001` above are **placeholders** — set them
to your own values.

## The Economics: What You Actually Get (Real-world Data)

Most developer platforms advertise "free tiers" that vanish after two days of testing.
Based on our real-world continuous deployment and production accounting, here is
the exact breakdown of what CNB provides and how far it stretches:

### Monthly Quota Breakdown

| Resource | Monthly Quota | Equivalent Real-world Value | Real Uptime & Capacity |
|---|---|---|---|
| **AI Credits** | **500 ~ 1,166 credits** | ¥500 ~ ¥1,166 of direct model API spend | **300M ~ 1B+ Tokens** on flash models (see below) |
| **Dev Core-Hours** | **1,600 core-hours** (5,760,000s) | A dedicated 2-vCPU cloud container running 24/7 | **33.3 days** of non-stop execution (outlasts a 30-day month) |
| **CI Core-Hours** | **160 ~ 1,600 core-hours** | Automated testing & keepalive pipelines | **~18–20 core-hours/month** used by the 5-min cron |

> **How to get 1,166 Credits**: 500 credits are granted to every verified org upon registration.
> Another 666 credits/month are awarded automatically upon completing the official
> *hello-cnb* onboarding challenge ("Genius Programmer" badge). Both quotas renew monthly.

### Capacity & Token Economics

- **33.3 Days of 2-vCPU Uptime**: A default `runner.cpus: 2` workspace burns `2 × 24 = 48` core-hours per day. Running 24/7 for a full 30-day month consumes `1,440` core-hours, leaving a comfortable **160 core-hour safety buffer**. You never need to shut down the proxy to conserve compute.
- **300 Million to 1 Billion Tokens/Month**: The upstream flagship `deepseek-v4-flash` offers ultra-competitive pricing (roughly 1 credit per 500k–1M tokens). With 1,166 monthly credits, you have an effective allowance of **10M to 30M tokens per day** — more than enough for intensive Copilot/Cursor coding, autonomous agent loops, and daily translation.
- **Negligible Cron Overhead**: The keepalive pipeline runs every 5 minutes, taking only 6–8 seconds in a lightweight container (~0.002 core-hours per run), totaling less than 20 core-hours across the entire month.

### Workspace Lifecycle & SLA (99.85% Availability)

- **Max Continuous Run**: Up to 18 hours per session (`options.keepAliveTimeout: 64800000`).
- **Recycle Window**: CNB recycles workspaces during the 04:00–06:00 UTC+8 overnight window if runtime exceeds 8 hours.
- **Recovery Benchmark**: In live testing, when a workspace is recycled, the 5-minute cron detects it, boots a new container in ~35s, and self-registers the new subdomain. The entire switchover finishes in **~2 minutes 13 seconds**.
- **Real-world SLA**: Over a 30-day period, total recycling downtime is roughly 66 minutes, delivering an empirical **99.85% uptime SLA** on purely ephemeral compute.

## Supported Models & Matrix

CNB's AI gateway routes inference directly to high-speed upstream models. By default, cnb2api is configured to expose the full model suite:

| Model ID | Architecture & Capabilities | Context Window | Native Tool Calls (`tools`) | Reasoning Stream (`reasoning_content`) | Best For |
|---|---|---|:---:|:---:|---|
| `deepseek-v4-flash` *(Default)* | State-of-the-art multimodal / high-throughput architecture | 64k ~ 128k | ✅ Yes | ✅ Yes (Full aggregation) | Daily coding, autonomous agents, high-concurrency tasks |
| `glm-5.3-flash` *(Alias)* | General-purpose smart router alias | 64k ~ 128k | ✅ Yes | ✅ Yes | Clients pre-configured with GLM conventions |
| `kimi-k3` *(Alias)* | Extended-context capable smart router alias | 64k ~ 128k | ✅ Yes | ✅ Yes | Long-context reading and document QA |
| `deepseek-chat` *(Alias)* | Universal standard OpenAI alias | 64k ~ 128k | ✅ Yes | ✅ Yes | Drop-in replacement for standard OpenAI client tools |

All models support both **streaming SSE** and **non-streaming** requests with complete token usage aggregation (`prompt_tokens`, `completion_tokens`, `total_tokens`).

## Get started — deploy on CNB

**Start here: [docs/SETUP.md](docs/SETUP.md)** — a from-zero walkthrough
(code repo → secrets repo with `allow_slugs` → `.cnb.yml` edits → workspace
boot → end-to-end verification, plus a troubleshooting table). ~10 minutes if
you already have a CNB account with AI credits.

Prerequisites in one line: a CNB account whose org has AI credits enabled and
knowledge of your model names (`PROXY_MODELS`). Quota expectations: a 2-cpu
always-on workspace ≈ 48 core-hours/day against CNB's free ~1600 core-hours/month.

For the optional fixed public domain (`https://ai.example.com/v1`) that follows
workspace restarts automatically, deploy the nginx relay described in
[docs/DEPLOY.md](docs/DEPLOY.md). Without it, use the raw
`https://<subdomain>-9001.cnb.run/v1` URL printed in the build log (it changes
on each workspace restart).

See [`.env.example`](.env.example) for every knob.

## Quota dashboard (CLI)

Your CNB org ships with monthly AI credits and free core-hours, but CNB only
shows them buried in the web console. `cnb2api-quota` puts them one command
away, right in your terminal:

```bash
npm run quota                 # or: npx cnb2api-quota
```

```
  ◆ CNB quota  your-org

  Credits  ███████▋───────────────────  32%   320.0 / 1,000.0 cr
  Dev      ██████▏─────────────────────  25%   406.4 / 1,600.0 core-h
  CI       █▋──────────────────────────   8%   13.0 / 160.0 core-h

  in-flight (not yet settled): 12.0 cr, 0.8 core-h

  remaining credits: 680.0 cr   as of 2026-01-15 08:30:00 UTC
```

Traffic-light bars (green → yellow → red as you burn down), thousands
separators, and in-flight amounts that are reserved but not yet settled. Two
more output modes for machines and prompts:

```bash
cnb2api-quota --json          # normalized snapshot for scripts
cnb2api-quota --line          # one-liner for status bars / shell prompts
```

It reads CNB's charge API directly (`/-/charge/quota` + `/-/charge/volume`),
so it works whether or not your proxy workspace is running, and it never needs
the pipeline `CNB_TOKEN`'s special scopes — any token that can see the org's
billing works. Org comes from `CNB_REPO_SLUG`, or override with
`--org <org>` / `QUOTA_ORG`.

## Use it anywhere

The endpoint speaks plain OpenAI chat completions, so anything that accepts a
custom base URL just works — set the base URL to your fixed domain
(`https://ai.example.com/v1`) and the API key to `PROXY_KEY`:

- **Chat UIs** — LobeChat, Cherry Studio, Open WebUI, NextChat…
- **Coding agents / SDKs** — Codex CLI, the official `openai` SDK, or any
  OpenAI-compatible toolchain.
- **curl** — see the example under [Local development](#local-development).

## Local development

Run the test suite (mock upstream, no real API calls):

```bash
node --test
```

Run the proxy standalone (pointing at any OpenAI-style upstream via the test hook):

```bash
PROXY_KEY=my-secret \
CNB_TOKEN=dummy \
CNB_REPO_SLUG=your-org/ai-proxy \
UPSTREAM_OVERRIDE=http://127.0.0.1:8080 \
node src/server.mjs
```

Then:

```bash
curl http://127.0.0.1:9001/v1/chat/completions \
  -H "Authorization: Bearer my-secret" -H "Content-Type: application/json" \
  -d '{"model":"model-a","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `PROXY_KEY` | — (required) | Bearer key clients must send. No default; refuses to start if missing. |
| `CNB_TOKEN` | — (required) | Upstream token; injected by the CNB pipeline stage. |
| `CNB_REPO_SLUG` | `CNB_BUILD_REPO` | `org/repo` used to build the upstream URL. Auto-filled inside a workspace. |
| `PROXY_MODELS` | `deepseek-v4-flash,glm-5.3-flash,kimi-k3,deepseek-chat` | Comma-separated ids advertised on `/v1/models`. |
| `PROXY_PORT` | `9001` | Listen port. |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `15000` | Upstream connect / first-byte timeout. |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | Per-stream idle watchdog. |
| `REGISTER_URL` | — (optional) | Relay `/ops/register` endpoint for self-registration. |
| `REG_TOKEN` | — (optional) | Shared secret for self-registration. |
| `QUOTA_ORG` | — (optional) | Org for the quota CLI when it differs from `CNB_REPO_SLUG`. |
| `UPSTREAM_OVERRIDE` | — | Test-only: point the upstream at a local mock. |

## FAQ

**How is this different from the anonymous CNB proxies on GitHub?**
Fundamentally. Those wrap the front-end NPC chat endpoint that
[CNB](https://cnb.cool) exposes for anonymous web visitors: they scrape CSRF
tokens, rotate session pools, and re-derive the protocol whenever the site
changes — fragile, account-free, and clearly not what the platform intends.
cnb2api uses the **official workspace AI endpoint** instead: documented path,
your org's credits, full `tools` support, and a usage trail on your own
account. It costs your allowance rather than someone else's patience — and it
stays working.

**Is it really zero dependencies?**
Yes. Runtime and tests use Node 22 built-ins only — there is nothing to
`npm install`, and nothing in `node_modules` to audit.

**What does running it cost?**
The code is MIT and free. You spend your CNB allowance: AI credits per
request, plus core-hours while the keepalive holds the workspace open
(≈48 core-hours/day at 2 CPUs — the budget math is in
[SETUP.md](docs/SETUP.md)).

**Which API endpoints are implemented?**
`/v1/chat/completions` (SSE streaming + non-streaming), `/v1/models`, and
`/health`. No embeddings/audio/files — the upstream doesn't offer them either.

**Where do my keys live?**
`PROXY_KEY` and `REG_TOKEN` stay in your private secrets repo and are injected
at build time via `imports:`. No long-lived CNB token is ever written to disk.

**Does it work with Anthropic-format clients?**
Not directly — this is an OpenAI-compatible shim. Use a client that speaks
OpenAI format (most chat UIs and agents do).

**Do native tool calls work?**
Yes. Requests go through the official endpoint with your pipeline token, so
`tools` / `tool_calls` are passed through untouched — no prompt-injection
workarounds needed.

**Is this really "high availability"? It's one workspace.**
It's HA at the service level, not the instance level: the service (a stable
URL + working proxy) survives daily workspace recycles automatically, with
recovery measured in minutes and zero human intervention. What you give up
vs. a real multi-node setup is a few minutes of unavailability during each
recovery — for a personal AI gateway, that trade is hard to beat at zero
extra infrastructure cost.

**Is this affiliated with CNB?**
No. Independent, personal-use project — see the note under
[License](#license). Respect the platform's terms of service.

## License

MIT — see [LICENSE](LICENSE).

> Not affiliated with CNB. This is an independent, personal-use compatibility
> shim. Respect the AI provider's and platform's terms of service.

If cnb2api saved you a paid API subscription, consider giving it a ⭐ — it
helps other CNB users find it.
