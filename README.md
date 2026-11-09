<!-- markdownlint-disable-file MD033 MD045 -->
<div align="center">

# CNB2API

**Production-Ready Dual-Protocol Gateway Bridging CNB Cloud Models into OpenAI & Anthropic Claude APIs**

[![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933.svg?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![OpenAI](https://img.shields.io/badge/Protocol-OpenAI-412991.svg?style=flat-square&logo=openai&logoColor=white)](https://platform.openai.com/)
[![Anthropic](https://img.shields.io/badge/Protocol-Anthropic%20Claude-D97706.svg?style=flat-square&logo=anthropic&logoColor=white)](https://docs.anthropic.com/)
[![Tests](https://img.shields.io/badge/tests-103%20passed-brightgreen.svg?style=flat-square)]()

[English](./README.md) · [简体中文](./README.zh-CN.md) · [Core Features](#core-features) · [Architecture](#system-architecture) · [Quick Start](#quick-start) · [Claude Code Integration](#claude-code-integration) · [Quota Dashboard](#terminal-quota-dashboard)

<br>

<p align="center">
  <b>Terminates network isolation barriers and ephemeral token expiration for CNB cloud workspace models.</b><br>
  Converts intranet-locked DeepSeek completion streams into production-grade OpenAI and Anthropic Claude APIs with zero runtime npm dependencies.<br>
  Features native Claude Code direct connection with anti-block rewrites, automated dual-watchdog self-healing with dynamic subdomain registration, and real-time ANSI quota dashboards.
</p>

</div>

---

## Motivation & Architecture Comparison

CNB provides verified organizations with 500 to 1,166 AI Credits and 1,600 compute core-hours monthly for free. Combined with upstream prompt caching discounts, organizations can unlock up to 200 million free DeepSeek tokens per month. However, the completion endpoint is locked inside isolated workspace networks using ephemeral tokens, and containers are recycled daily:

| Evaluation Dimension | CNB2API Gateway | Community Web Scrapers | Direct Public Cloud Access |
| :--- | :--- | :--- | :--- |
| **Monthly Free Capacity** | Up to ~200M DeepSeek tokens (1,166 credits + 30x prompt cache) | Unstable, prone to immediate rate-limiting | 0 (Blocked by network isolation policy) |
| **Network Reachability** | Intranet proxy + dynamic relay for stable public egress | Requires headless browser and residential proxies | Blocked by network policy (HTTP 403) |
| **Authentication Flow** | Ephemeral `CNB_TOKEN` minted via pipeline (zero static secret leakage) | Scraping session cookies and frontend tokens | Personal access tokens rejected (pipeline-only) |
| **Dual Protocols** | Full OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`) | Partial text-only OpenAI imitation | None |
| **Claude Code Direct** | Native direct connection with 11128 billing header neutralizer | Unsupported (no tool-calling, immediate block) | Unsupported |
| **Tool Calling / Functions** | Full pass-through (incremental streaming JSON delta assembly) | Unsupported | None |
| **Runtime Dependencies** | True Zero Dependencies (Node.js 22+ native primitives, instant boot) | Heavy dependencies (Chromium, Puppeteer, Python) | None |
| **High Availability** | v5.2 Dual-watchdog self-healing (internal cron + external watchdog) | Single point of failure on DOM changes | None |
| **Telemetry & Quota** | Built-in CLI dashboard (`cnb2api-quota`) + `/usage` endpoint | Black-box without consumption tracking | Buried deep inside web console |

---

## Core Features

| Module | Feature Highlight | Technical Implementation & Advantage |
| :--- | :--- | :--- |
| **Dual-Protocol Engine** | OpenAI + Anthropic Claude compatibility | Maps `/v1/chat/completions` and `/v1/messages` with bidirectional conversion, thinking block filtering, and usage tracking. |
| **Outbound Neutralizer** | 3-layer anti-blocking defense | Rewrites client billing headers/prompts, normalizes `developer` to `system`, and implements an automated fallback ladder on HTTP 400/11128 rejections. |
| **Zero-Dependency Core** | Minimal attack surface & instant cold start | Built strictly with Node.js 22+ built-in primitives (`fetch`, `ReadableStream`, `crypto.timingSafeEqual`), requiring no `npm install`. |
| **v5.2 HA Self-Healing** | Zero static credentials & auto-registration | Workspace boots with ephemeral `CNB_TOKEN`, POSTs its new subdomain to `/ops/register`, and auto-reloads Nginx upstream configurations in ~2m 13s. |
| **Dormancy Watchdog** | Anti-idle cron fail-safe | External probe detects pipeline dormancy caused by inactive repositories and issues automated OpenAPI startup triggers. |
| **Streaming Tool Calls** | Faithful incremental function calling | Reassembles streaming `input_json_delta` chunks and aggregates non-streaming `tool_calls` structures transparently. |
| **Dynamic Model Discovery** | Autonomous upstream model tracking | Automatically sniffs the actual model identifier from completion responses (e.g. `deepseek-v4.1-flash`) and advertises it in `/v1/models`. |
| **Terminal Quota Monitor** | Instant resource audit from CLI | Bundled `cnb2api-quota` CLI displays ANSI bar meters for AI credits, development core-hours, and CI compute quotas. |

---

## System Architecture

```text
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

### Self-Healing Lifecycle

1. **Automated Recovery**: An internal cron pipeline checks workspace connectivity and triggers start sequences if stopped.
2. **Subdomain Sync**: On boot, `deploy/start.sh` registers the new assigned subdomain with `/ops/register`, immediately updating the Nginx routing upstream.
3. **External Fail-safe**: An external watchdog (`cnb-watchdog.sh`) monitors the fixed domain to guard against CI platform cron dormancy.

---

## Quick Start

### 1. Deployment Steps

1. **Fork Private**: Fork this repository as a private repository on CNB.
2. **Configure API Key**: In `.cnb.yml`, define your custom `PROXY_KEY` in the `env:` configuration block (e.g., generated via `openssl rand -hex 24`).
3. **Launch Cloud Workspace**: Click "Start Cloud Development" on CNB. The build console outputs `PROXY_URI=https://<subdomain>-9001.cnb.run` once online.

### 2. curl Verification

```bash
curl https://<subdomain>-9001.cnb.run/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

---

## Claude Code Integration

Connect Anthropic Claude Code directly to your CNB DeepSeek endpoints:

```bash
export ANTHROPIC_BASE_URL="https://ai.example.com"
export ANTHROPIC_AUTH_TOKEN="your-proxy-key"
export ANTHROPIC_MODEL="deepseek-v4.1-flash"

claude -p "Explain the actor model in distributed computing."
```

---

## Quota & Cost Estimates: 200M Free Monthly Tokens

Production billing data measured over months of live operations:

| Resource Allowance | Free Monthly Quota | Capacity & Economics |
| :--- | :--- | :--- |
| **AI Credits** | 500 base, up to 1,166 credits | Every response reports exact credit consumption. Combined with Prompt Caching, delivers ~200M tokens/month. |
| **Compute Core-Hours** | 1,600 core-hours (shared pool) | A 2-CPU workspace running 24/7 for 30 days consumes 1,440 core-hours, operating safely within the free limit. |

### Capacity Calculation

1. **Uncached Base Rate**: On `deepseek-v4.1-flash`, an uncached 9,000-token prompt costs ~0.39 credit (~23,000 tokens/credit).
2. **Prompt Cache Discount**: When prompt prefixes hit the cache, cost falls to ~0.01 credit per request (a 30x discount, yielding ~700,000 tokens/credit).
3. **Blended Real-World Workloads**: In typical coding assistant, Claude Code, and multi-turn Agent conversations with ~90% prompt cache hit rates:
   $$\text{Blended Cost} = 10\% \times 1 + 90\% \times \frac{1}{30} \approx 13\% \text{ of base cost} \implies \approx 177,000\text{ tokens / credit}$$
   $$\text{Monthly Total} = 1,166\text{ credits} \times 177,000\text{ tokens} \approx \mathbf{206\text{ Million tokens / month}}$$

---

## Terminal Quota Dashboard

Inspect real-time quota balances and settled consumption directly from your shell:

```bash
npm run quota
# or: npx cnb2api-quota
```

```text
  CNB Quota Balance  org-slug

  Credits  ███████▋───────────────────  32%   320.0 / 1,000.0 cr
  Dev      ██████▏─────────────────────  25%   406.4 / 1,600.0 core-h
  CI       █▋──────────────────────────   8%    13.0 / 160.0 core-h

  In-flight (unsettled): 12.0 cr, 0.8 core-h
  Remaining balance:     680.0 cr as of 2026-11-09 08:30:00 UTC
```

- `cnb2api-quota --line`: Single-line summary, ideal for prompt status lines.
- `cnb2api-quota --json`: Structured JSON stream for external automation monitors.

---

## Configuration Reference

| Environment Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PROXY_KEY` | None (Required) | Secret token required in `Authorization: Bearer` or `x-api-key` headers. |
| `CNB_TOKEN` | None (Required) | Injected automatically by the CNB pipeline environment. |
| `CNB_REPO_SLUG` | Built-in | Format `org/repo` targeting upstream routing. Populated by CNB. |
| `PROXY_MODELS` | `deepseek-v4.1-flash,glm-5.3-flash,kimi-k3` | Initial fallback model list until dynamic discovery detects upstream models. |
| `PROXY_MODELS_STATE` | `models-state.json` | Path where discovered model names persist across restarts. |
| `PROXY_PORT` | `9001` | Local listening port for the proxy service. |
| `PROXY_UPSTREAM_TIMEOUT_MS`| `15000` | Upstream connection and first-byte timeout in milliseconds. |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | Inactivity watchdog timeout for long-lived streams. |
| `PROXY_NEUTRALIZE` | `1` | Outbound client-fingerprint neutralization. Set to `0` to send raw payloads. |
| `PROXY_NEUTRALIZE_AGGRESSIVE` | `0` | Aggressive brand token neutralization. |
| `PROXY_BLOCK_RETRY` | `1` | 11128 fallback ladder: folds system prompts and word-obfuscates on rejection. |
| `PROXY_ENSURE_SYSTEM` | `1` | Normalizes `developer` role to `system`. |
| `PROXY_SYNTHETIC_SYSTEM` | `0` | Prepends synthetic system prompt when absent. |
| `CNB2API_ALLOW_THINKING` | `0` | Set to `1` to forward thinking toggles upstream. |
| `REGISTER_URL` | None (Optional) | Target relay endpoint (`/ops/register`) for dynamic registration. |
| `REG_TOKEN` | None (Optional) | Shared secret token authorizing registration calls. |

---

## Frequently Asked Questions

**Why does the model list initially include GLM or Kimi?**  
The `/v1/models` endpoint uses autonomous model discovery. The upstream CNB gateway lacks a standalone model catalog API, so the proxy sniffs actual model names from completion headers. The static fallback list ensures standard client dropdowns function immediately on first start.

**Are streaming tool calls and multi-turn functions supported?**  
Yes. In streaming mode, partial `input_json_delta` chunks are assembled into complete JSON arguments. In non-streaming mode, standard OpenAI `tool_calls` payloads are emitted.

**How does the Outbound Neutralizer mitigate 11128 errors?**  
Upstream gateways enforce client-fingerprint moderation on `system` and `assistant` texts. CNB2API mitigates this via a three-layer pipeline: ① rewriting signature phrases and adding zero-width spaces to identity tokens; ② normalizing `developer` roles to `system`; ③ executing an automated retry ladder folding system prompts into user messages on HTTP 400/11128.

**Does this service violate CNB platform policies?**  
No. CNB2API runs within your own authorized cloud workspace, calls documented platform completion APIs using platform-issued ephemeral tokens, and strictly consumes your own allocated organization quotas.

---

## Contributing & License

Contributions and improvements are welcome. Please ensure that all test suites pass before submitting changes:

```bash
node --test test/*.test.mjs
```

Licensed under the [MIT License](LICENSE).
