<div align="center">

# cnb2api

**Turn CNB Cloud Workspace In-Network AI into a Production-Ready API Gateway**

**Get Up to 200M Free DeepSeek Tokens Monthly · Zero External Dependencies · 7×24h Self-Healing HA**

*OpenAI + Anthropic Dual Protocols · Zero-Config Claude Code Direct Connect · v5.2 Architecture · Terminal Quota Dashboard*

[![Tokens](https://img.shields.io/badge/DeepSeek%20Tokens-Up%20to%20200M%2Fmo%20(Free)-10a37f?style=flat&logo=deepseek)](#quota-calc)
[![test](https://github.com/dengyie/cnb2api/actions/workflows/test.yml/badge.svg)](https://github.com/dengyie/cnb2api/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English · [简体中文](README.zh-CN.md)

</div>

> **TL;DR**: CNB grants verified orgs **500 ~ 1,166 AI Credits** and **1,600 compute core-hours** monthly for free. Combined with CNB's 30x prompt caching discount, you can enjoy **up to ~200 Million DeepSeek Tokens per month for free**! However, the AI completion endpoint is strictly locked inside the workspace intranet with ephemeral pipeline tokens, while containers are recycled daily. **cnb2api** runs inside the workspace, converts it into a standard public API with zero dependencies, and leverages a **v5.2 dual-watchdog self-healing architecture** to deliver permanent domain access and 7×24 HA.

---

### Why cnb2api?

| Dimension | cnb2api (This Project) | Community Web NPC Scrapers | Direct Public Calling |
|:---|:---|:---|:---|
| **Monthly Free Quota** | **Up to ~200M DeepSeek Tokens** (1,166 Credits + Prompt Cache) | Unstable, easily rate-limited or banned | 0 (Blocked by network isolation) |
| **Access Route** | **Official Workspace Intranet Endpoint** | Web frontend anonymous NPC chat | Official Public Endpoint |
| **Compliance & Account** | **100% Compliant**, consumes your org's quota | Violates ToS, scraping, ban risk | Cannot call (Network policy blocked) |
| **Network Reachability** | Intranet proxy + dynamic relay, **Public stable access** | Requires headless browser/proxy pools for CSRF | ❌ 403 `Blocked by network policy` |
| **Auth Mechanism** | Ephemeral `CNB_TOKEN` via pipeline (Zero leakage) | Web cookies / session scraping | ❌ Personal tokens 403 (Pipeline only) |
| **Protocol Support** | **OpenAI + Anthropic Dual Protocol Stack** | Partial OpenAI text-only imitation | None |
| **Claude Code Direct** | **Native Direct Connect** (with 11128 workaround) | ❌ Unsupported (no tools / blocked) | None |
| **Native Tool Calling** | **Full pass-through** (incremental streaming merge) | ❌ Unsupported | None |
| **External Dependencies** | **Zero Dependencies** (Node.js 22+ built-in, instant boot) | Heavy dependencies (Chromium, Puppeteer) | None |
| **High Availability** | **v5.2 Dual-Watchdog Self-Healing** (Internal cron + watchdog) | Single point of failure on UI changes | None |
| **Quota Transparency** | **Built-in Terminal CLI Dashboard** + `/usage` metrics | Black-box, no usage tracking | Only visible deep in web console |

---

### Key Features

- 💰 **Up to 200M Free DeepSeek Tokens Monthly**:
  - Fully unleashes the 500~1,166 monthly AI Credits provided for free by CNB.
  - Native **30x Prompt Cache discount** on upstream completions. In typical coding assistant, Claude Code, and multi-turn Agent scenarios with high prompt reuse, effective capacity reaches **~200M tokens/month**.
- ⚡ **Native Dual-Protocol Support**:
  - **OpenAI Compatible**: `/v1/chat/completions` and `/v1/models`, supporting SSE streaming and faithful non-streaming aggregation (reconstructing `usage`, exact `credit` costs, incremental `tool_calls`, and `finish_reason`).
  - **Anthropic Compatible**: `/v1/messages` and `/v1/messages/count_tokens`, enabling **Claude Code CLI direct connection** with full support for thinking blocks, tool calling, and event streams.
  - 🛡️ **Outbound Neutralizer**: Transparently rewrites Claude Code internal billing headers and signature prompt phrases, eliminating false-positive 11128 upstream blocks without altering semantics.
- ♻️ **v5.2 Zero Long-Lived Credentials + Self-Healing HA**:
  - **Zero Token Leakage**: No static long-lived platform tokens in the workspace. The self-healing cron pipeline uses ephemeral platform `CNB_TOKEN`s minted on demand and destroyed on completion.
  - **Dynamic Routing Follower**: On boot, `start.sh` registers the new dynamic subdomain to your relay (`/ops/register`), which hot-reloads nginx upstream configurations. Client URLs and keys stay permanent. Full recovery takes **~2m 13s**.
  - **Dormancy Watchdog**: Circumvents CI platform cron dormancy (CNB pauses crons if no commits occur over multiple days). An external watchdog (`cnb-watchdog.sh`) detects stalled states and silently triggers fallback OpenAPI starts with cooldown protection.
- 🪶 **True Zero Dependencies**: 100% built on Node.js 22+ native primitives (`fetch`, `ReadableStream`, `crypto.timingSafeEqual`, `node:test`). Zero `npm install`, instant cold starts.
- 📊 **Monitoring & Quota Dashboard**:
  - `cnb2api-quota` CLI: One-command ANSI progress bar dashboard showing AI credits, dev core-hours, CI core-hours, and in-flight amounts directly from the official charge API. Supports `--json` and `--line`.
  - In-memory `GET /usage` accounting endpoint grouped by boot generation with UTC+8 daily rollups.

---

## How It Works

```
Client (OpenAI Client / Claude Code / API Gateway)
  │  https://ai.example.com/v1 (Fixed domain, self-hosted Nginx relay)
  ▼
https://<dynamic-subdomain>-9001.cnb.run (CNB port-proxy, auto-synced via /ops/register on boot)
  │
  ▼
node src/server.mjs (Workspace port 9001, cnb2api reverse proxy)
  │  Bearer CNB_TOKEN (Auto-minted by CNB pipeline, internal network)
  ▼
https://api.cnb.cool/<org>/<repo>/-/ai/chat/completions (Official AI core endpoint)
```

The workspace is treated as **cattle, not a pet**:
1. **Cron Recovery**: An internal cron pipeline (`*/5 * * * *`) checks workspace health and calls `workspace/start` if stopped.
2. **Auto-Registration**: On boot, `deploy/start.sh` POSTs the newly assigned subdomain to `/ops/register` on your relay, which reloads Nginx.
3. **External Fallback**: An external VPS watchdog (`cnb-watchdog.sh`) monitors the fixed domain to guard against CI platform cron dormancy.

---

## Quickstart

Three simple steps, only one API key to configure:

1. **Fork Private**: Fork this repository as a **private repo** on CNB.
2. **Configure API Key**: In `.cnb.yml`, set your custom `PROXY_KEY` in the `env:` block (e.g. `openssl rand -hex 24`).
3. **Launch Cloud Workspace**: Click "Start Cloud Development" on CNB. The build log prints `PROXY_URI=https://<subdomain>-9001.cnb.run` — ready to use!

> 💡 Need a permanent domain? Set up a simple Nginx reverse proxy on your VPS with `/ops/register`. See the [Full Setup Guide (docs/SETUP.md)](docs/SETUP.md).

---

## Client Integration Examples

### 1. Claude Code Direct Connect (Anthropic Protocol)
```bash
ANTHROPIC_BASE_URL=https://ai.example.com \
ANTHROPIC_AUTH_TOKEN=your-proxy-key \
ANTHROPIC_MODEL=deepseek-v4.1-flash \
claude -p "Hello! Introduce yourself."
```

### 2. OpenAI Clients & Gateways
Point BaseURL to `https://ai.example.com/v1` and set API Key to `PROXY_KEY`:
- **Chat Apps**: NextChat, LobeChat, Cherry Studio, Open WebUI
- **Gateways**: New API, One API (Channel type: OpenAI, model: `deepseek-v4.1-flash`)
- **Coding Agents**: Cursor, Continue, Codex CLI

### 3. curl Verification
```bash
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

---

<span id="quota-calc"></span>
## Quota & Cost Estimates: How to Get 200M Tokens Free Monthly

Real production billing data measured over months of live operation (not marketing hype):

| Resource Allowance | Free Monthly Quota | Cost & Capacity Notes |
|:---|:---|:---|
| **AI Credits** | Base **500**, up to **1,166** after *hello-cnb* quest | Every response reports exact `credit` in `usage`. Combined with Prompt Cache, delivers **~200M DeepSeek Tokens/month**. |
| **Compute Core-Hours** | **1,600 core-hours** (shared dev + CI pool) | A `runner.cpus: 2` workspace running 24/7 for 30 days costs **1,440 core-hours** (safely within the 1,600 pool). No need to stop the proxy. |

> 💡 **The Math Behind 200M Free Tokens/Month**:
> 1. **Base Upstream Rate**: Live measurements on `deepseek-v4.1-flash` show an uncached 9,000-token request costs ~0.39 credit (approx **23,000 tokens / credit**).
> 2. **Official Prompt Cache 30x Discount**: Once prompt prefixes hit CNB's prompt cache, cost drops to **~0.01 credit**, slashing cost to **1/30** of base price (~**700,000 tokens / credit**).
> 3. **Real-World Scenarios**: In coding assistants, Claude Code, and multi-turn Agent conversations with long system prompts and history reuse, cache hit rates typically sit at 80%~95% (assuming a realistic **90% cache hit rate**):
>    $$\text{Blended Cost} = 10\% \times 1 + 90\% \times \frac{1}{30} \approx 13\% \text{ base cost} \implies \approx 177,000\text{ tokens / credit}$$
>    $$\text{Monthly Total} = 1,166\text{ credits} \times 177,000\text{ tokens} \approx \mathbf{206\text{ Million tokens / month}}$$
> 4. Run `npm run quota` anytime in your terminal to inspect your live remaining credits and consumption.

---

## Quota Dashboard (CLI)

Check your quota and usage straight from the terminal, even if the proxy workspace is offline:

```bash
npm run quota                 # or: npx cnb2api-quota
```

```text
  ◆ CNB quota  your-org

  Credits  ███████▋───────────────────  32%   320.0 / 1,000.0 cr
  Dev      ██████▏─────────────────────  25%   406.4 / 1,600.0 core-h
  CI       █▋──────────────────────────   8%   13.0 / 160.0 core-h

  in-flight (not yet settled): 12.0 cr, 0.8 core-h
  remaining credits: 680.0 cr   as of 2026-01-15 08:30:00 UTC
```

- `cnb2api-quota --line`: Compact one-liner, ideal for shell status bars.
- `cnb2api-quota --json`: Structured JSON output for automation scripts.

---

## Configuration

| Environment Variable | Default | Purpose |
|:---|:---|:---|
| `PROXY_KEY` | — (required) | Bearer key / x-api-key sent by clients. Refuses to start if missing. |
| `CNB_TOKEN` | — (required) | Upstream token injected by CNB pipeline environment. |
| `CNB_REPO_SLUG` | (built-in) | `org/repo` used for upstream routing. Auto-filled by CNB. |
| `PROXY_MODELS` | `deepseek-v4.1-flash,glm-5.3-flash,kimi-k3` | **Fallback** model ids for `/v1/models` — used only until a response reveals the real upstream model name. |
| `PROXY_MODELS_STATE` | `models-state.json` | Where the sniffed-model registry is persisted across workspace restarts. Relative paths resolve against the run dir. |
| `PROXY_PORT` | `9001` | Listen port. |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `15000` | Upstream connect / first-byte timeout (ms). |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | Per-stream idle watchdog (ms). |
| `CNB2API_ALLOW_THINKING` | off | Set to `1` to forward client thinking toggles (`reasoning_effort` / `reasoning` / `enable_thinking` / `thinking`, and Anthropic `thinking:{type:"enabled"}`) to the upstream thinking variant instead of stripping them. Only use it if your clients send a large `max_tokens` — see the thinking note below. |
| `REGISTER_URL` | — (optional) | Relay `/ops/register` endpoint for self-registration. |
| `REG_TOKEN` | — (optional) | Shared secret for self-registration. |

### Thinking is stripped by default

The upstream thinking variant bills its reasoning phase against `max_tokens`. With a
small budget the reasoning consumes the whole allowance, the stream ends with
`finish_reason: length` and **no answer is ever generated** (measured: a hard prompt
at `max_tokens` 2048 and 8192 produced 4.6k / 20.3k characters of reasoning and zero
content). To keep clients from hitting that, thinking toggles are removed from every
outbound request.

That default is safe but absolute: it also locks out callers that *do* provide a large
budget, for whom thinking works correctly (verified at `max_tokens: 60000`, where
reasoning and answer are emitted in sequence). Set `CNB2API_ALLOW_THINKING=1` to opt in
and take responsibility for the budget. Requests that carry no thinking toggle behave
identically either way.

---

## FAQ

**Q: Why does the model list include glm and kimi when the backend is DeepSeek?**  
A: `/v1/models` is **self-discovering**: the CNB gateway has no list endpoint, so the proxy learns the real model name from every completion response (the gateway echoes the resolved id, e.g. `deepseek-v4.1-flash`) and advertises that. `PROXY_MODELS` is only a fallback for the very first requests before anything has been sniffed — it exists so client presets that name glm/kimi keep working out of the box, and you can freeze it to whatever `/v1/models` has been returning.

**Q: Are native Tool Calls / Function Calling supported?**  
A: Fully supported. In streaming mode, `input_json_delta` chunks are cleanly combined; in non-streaming mode, standard `tool_calls` structures are reassembled.

**Q: Does this violate CNB Terms of Service?**  
A: No. It runs inside your own authorized workspace, calls official documented endpoints, uses platform-minted tokens, and consumes your own allocated quota. No reverse-engineered frontend endpoints or anonymous scraping.

---

## License

MIT © [dengyie](https://github.com/dengyie/cnb2api)
