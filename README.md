<div align="center">

# cnb2api

**Your CNB free AI credits, served over a plain OpenAI-compatible API.**

[![test](https://github.com/dengyie/cnb2api/actions/workflows/test.yml/badge.svg)](https://github.com/dengyie/cnb2api/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English · [简体中文](README.zh-CN.md)

</div>

CNB gives every verified org a monthly pool of free AI credits — but they're
only reachable from **inside** a CNB cloud workspace (the endpoint needs a
pipeline `CNB_TOKEN` and CNB-internal networking). **cnb2api** runs a tiny
reverse proxy inside that workspace and turns it into a stable
`https://…/v1/chat/completions` URL that any OpenAI client can call from
anywhere.

- 🔓 **Above-board.** It uses only the **official, documented** workspace AI
  endpoint with the pipeline `CNB_TOKEN` CNB itself issues — no reverse-engineered
  front-end endpoints, no anonymous session scraping, nothing that fights the
  platform's rules.
- ♻️ **Survives daily recycling.** CNB reclaims workspaces overnight and the
  subdomain changes on every restart. A keepalive loop heals that automatically,
  so your clients keep one fixed URL and never notice — an always-on endpoint on
  a throwaway machine.
- 🪶 **Zero dependencies.** Node 22+ built-ins only (`fetch` / `AbortSignal` /
  streams); tests run on the built-in `node:test` runner. Nothing to `npm install`.
- 📊 **Quota in your terminal.** A one-command dashboard for your AI credits and
  core-hours — the only such tool in the CNB ecosystem.

## How it works

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

`ai.example.com`, `<org>/<repo>`, and port `9001` are **placeholders** — set them
to your own values. The fixed domain is optional; without it you use the raw
`https://<subdomain>-9001.cnb.run/v1` URL from the build log.

### Staying alive on a machine that dies daily

The workspace is treated as **cattle, not a pet**. A cron pipeline and a small
relay turn a box that gets recycled every night into an endpoint that behaves
like a high-availability VPS:

```
every 5 min (cron pipeline)          on every boot                 your relay
┌─────────────────────────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ workspace alive?            │   │ start.sh runs →      │   │ nginx upstream map  │
│  alive + domain OK → noop   │──▶│ POST /ops/register   │──▶│ repointed to the    │
│  domain dead      → re-reg  │   │ (current subdomain)  │   │ latest subdomain    │
│  not alive        → restart │   └──────────────────────┘   └─────────────────────┘
└─────────────────────────────┘
```

- **Self-healing** — the cron restarts a dead workspace; two failed health
  checks on the fixed domain trigger re-registration. No human in the loop.
- **Fixed address, moving backend** — clients only ever see one URL; the relay
  repoints to the fresh subdomain within minutes of a recycle. In a live drill,
  full recovery (detect → new workspace → re-register) took **~2m13s**.
- **No long-lived tokens on disk** — a recycled workspace carries nothing; the
  next boot mints a fresh `CNB_TOKEN` by design. Your `PROXY_KEY` and
  `REG_TOKEN` live in a private secrets repo, injected at build time.

This is HA at the **service** level, not the instance level: the stable URL and
working proxy survive recycles automatically. The cost is a couple of minutes of
downtime per recovery — a hard trade to beat for a personal gateway at zero
extra infrastructure. Design details: [docs/DESIGN.md](docs/DESIGN.md).

## Features

- **OpenAI-compatible** — `/v1/chat/completions` (streaming SSE + non-streaming),
  `/v1/models`, `/health`. Native **function/tool calls** pass through untouched.
- **Faithful non-stream aggregation** — reassembles `content`, incremental
  `tool_calls`, `reasoning_content`, `usage`, and `finish_reason` from the SSE
  stream into one complete `chat.completion` object.
- **Production-hardened forwarding** — connect timeout, per-stream idle watchdog,
  backpressure handling, and two-way cancellation (a client disconnect aborts the
  upstream, so you stop burning credits on an abandoned request).
- **Timing-safe key auth** — with a sliding-window failure limiter (429 on abuse).
- **Quota dashboard CLI** — `cnb2api-quota` reads CNB's charge API directly; see
  [below](#quota-dashboard-cli).

## Quickstart — deploy on CNB

Three steps, one value. Fork this repo **private**, put your own key in
`.cnb.yml`'s `env:` block (safe inside your own private repo — generate it
with `openssl rand -hex 24`), and start the cloud dev workspace. The build
log prints your endpoint (`PROXY_URI=https://<subdomain>-9001.cnb.run`) —
that plus your key is a working OpenAI base URL. No other edits: the
keepalive reads the built-in `CNB_REPO_SLUG`, so it needs zero per-user
configuration. Full walkthrough (including the team-grade secrets-repo flow
and the optional fixed-domain relay): [docs/SETUP.md](docs/SETUP.md).

## What you actually get

Two independent free allowances power this setup: **AI credits** for inference,
and **core-hours** for the compute the proxy runs on. The numbers below are
measured on our own running deployment — not marketing.

| Allowance | Free monthly quota | What it pays for |
|---|---|---|
| **AI credits** | **500** base, up to **1,166** with the *hello-cnb* bonus | Every AI request — each response's `usage` reports the exact `credit` it cost |
| **Compute core-hours** | **1,600 core-hours** (shared dev + CI pool) | The workspace running the proxy, plus the keepalive pipeline |

> The 500 base credits come with a verified org; completing CNB's official
> *hello-cnb* onboarding ("Genius Programmer" badge) adds a recurring monthly
> bonus (1,166/month on our account). Your total depends on your own account.

**Credits → tokens (measured).** The upstream returns a `credit` field in every
response's `usage`, so cost is exact. Against `deepseek-v4-flash`:

- A fresh (uncached) ~9,000-token request costs about **0.39 credit** — roughly
  **23,000 tokens per credit**, consistent across runs.
- An identical prompt hits CNB's prompt cache and drops to **~0.01 credit** —
  about **1/30** the price on the cached portion.

So the blended rate depends on your cache-hit rate. At a **90% hit rate** (fixed
system prompts, agent loops re-reading the same context) the average cost is
`10%×1 + 90%×(1/30) ≈ 13%` of full price — about **177k tokens/credit**, or
roughly **200M tokens/month** on 1,166 credits. Don't take any single figure on
faith: watch your real burn with the [quota CLI](#quota-dashboard-cli).

**Core-hours → uptime.** A `runner.cpus: 2` workspace burns **48 core-hours/day**;
a full 30-day month of continuous uptime is **1,440 core-hours**, inside the
**1,600** pool — you never have to shut the proxy down to save compute. The
5-minute keepalive adds only a few core-hours a month. CNB caps a session at
18h and recycles workspaces that run past 8h during the 04:00–06:00 (UTC+8)
window; the keepalive loop brings them straight back.

## Models

`/v1/models` advertises whatever you set in `PROXY_MODELS`. On our account the
CNB gateway currently exposes three ids — and routes all of them to one upstream
model today:

| Model id | Notes |
|---|---|
| `deepseek-v4-flash` | The model that actually answers today. |
| `glm-5.3-flash` | Accepted, but routed to `deepseek-v4-flash` (the response's `model` field confirms it). |
| `kimi-k3` | Same — currently routed to `deepseek-v4-flash`. |

The extra names exist for client compatibility. Set `PROXY_MODELS` to whatever
your own account exposes. Streaming and non-streaming requests, full `usage`
aggregation (including `credit`), and native `tools` calls are all verified
working against the live endpoint. Context-window limits are set by the upstream
and undocumented, so we don't quote a number we can't verify.

## Use it anywhere

The endpoint speaks plain OpenAI chat completions, so anything that accepts a
custom base URL just works. Point the base URL at your fixed domain
(`https://ai.example.com/v1`) and set the API key to your `PROXY_KEY`:

- **Chat UIs** — LobeChat, Cherry Studio, Open WebUI, NextChat…
- **Coding agents / SDKs** — Codex CLI, the official `openai` SDK, or any
  OpenAI-compatible toolchain.
- **curl** — see [Local development](#local-development).

## Quota dashboard (CLI)

CNB only shows your credits and core-hours buried in the web console.
`cnb2api-quota` puts them one command away:

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

Traffic-light bars (green → yellow → red), thousands separators, and in-flight
amounts reserved but not yet settled. Two more output modes:

```bash
cnb2api-quota --json          # normalized snapshot for scripts
cnb2api-quota --line          # one-liner for status bars / shell prompts
```

It reads CNB's charge API directly (`/-/charge/quota` + `/-/charge/volume`), so
it works whether or not your proxy workspace is running, and any token that can
see the org's billing works — no special pipeline scopes needed. The org comes
from `CNB_REPO_SLUG`, or override with `--org <org>` / `QUOTA_ORG`.

## Local development

Run the test suite (mock upstream, no real API calls):

```bash
node --test
```

Run the proxy standalone against any OpenAI-style upstream via the test hook:

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

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `PROXY_KEY` | — (required) | Bearer key clients must send. No default; refuses to start if missing. |
| `CNB_TOKEN` | — (required) | Upstream token; injected by the CNB pipeline stage. |
| `CNB_REPO_SLUG` | (built-in) | `org/repo` used to build the upstream URL. A built-in CNB variable, auto-filled inside every pipeline. |
| `PROXY_MODELS` | `deepseek-v4-flash,glm-5.3-flash,kimi-k3` | Comma-separated ids advertised on `/v1/models`. |
| `PROXY_PORT` | `9001` | Listen port. |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `15000` | Upstream connect / first-byte timeout. |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | Per-stream idle watchdog. |
| `REGISTER_URL` | — (optional) | Relay `/ops/register` endpoint for self-registration. |
| `REG_TOKEN` | — (optional) | Shared secret for self-registration. |
| `QUOTA_ORG` | — (optional) | Org for the quota CLI when it differs from `CNB_REPO_SLUG`. |
| `UPSTREAM_OVERRIDE` | — | Test-only: point the upstream at a local mock. |

## FAQ

**How is this different from the anonymous CNB proxies on GitHub?**
Fundamentally. Those wrap the front-end NPC chat endpoint CNB exposes for
anonymous web visitors — scraping CSRF tokens, rotating session pools, and
re-deriving the protocol whenever the site changes. That's fragile, account-free,
and clearly not what the platform intends. cnb2api uses the **official workspace
AI endpoint**: documented path, your org's credits, full `tools` support, and a
usage trail on your own account. It costs your allowance rather than someone
else's patience — and it keeps working when the UI changes.

**Do native tool calls work?**
Yes. Requests go through the official endpoint with your pipeline token, so
`tools` / `tool_calls` pass through untouched — no prompt-injection workarounds.

**Which API endpoints are implemented?**
`/v1/chat/completions` (SSE streaming + non-streaming), `/v1/models`, and
`/health`. No embeddings/audio/files — the upstream doesn't offer them either.

**Does it work with Anthropic-format clients?**
Not directly — this is an OpenAI-compatible shim. Use a client that speaks the
OpenAI format (most chat UIs and agents do).

**What does running it cost?**
The code is MIT and free. You spend your CNB allowance: AI credits per request,
plus core-hours while the keepalive holds the workspace open (≈48 core-hours/day
at 2 CPUs — see the budget math above).

**Is this affiliated with CNB?**
No. Independent, personal-use project. Respect the platform's terms of service.

## License

MIT — see [LICENSE](LICENSE).

> Not affiliated with CNB. This is an independent, personal-use compatibility
> shim. Respect the AI provider's and platform's terms of service.

If cnb2api saved you a paid API subscription, consider giving it a ⭐ — it helps
other CNB users find it.
