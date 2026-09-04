# Design

`cnb2api` exists to answer one question: **how do I get a stable
OpenAI-compatible URL out of an AI endpoint that only works from inside a CNB
cloud workspace?** Everything here serves "the address is stable and
discoverable, the key is rotatable, the behavior is predictable."

## 1. Constraints that shape the design

- The CNB AI endpoint (`https://api.cnb.cool/<org>/<repo>/-/ai/chat/completions`)
  is only reachable from inside CNB's network and needs a pipeline `CNB_TOKEN`.
  → the proxy **must run inside the workspace**.
- A CNB workspace subdomain (`<subdomain>-<port>.cnb.run`) **changes on every
  restart**, and the platform force-recycles workspaces (e.g. overnight).
  → any fixed public URL must **follow** the drifting subdomain automatically.
- Long-lived platform tokens expire and are a leak risk if stored.
  → keep **no long-lived CNB token** anywhere in the loop.

## 2. Module layout

```
src/
├── config.mjs   env loading + fail-fast validation (no default key, ever)
├── auth.mjs     Bearer key check (timing-safe) + sliding-window fail limiter
├── sse.mjs      SSE event parsing + non-stream aggregation
├── proxy.mjs    upstream forwarding: AbortSignal timeout + two-way cancel
├── server.mjs   http server + routing (/health, /v1/models, /v1/chat/completions)
└── log.mjs      structured single-line JSON logs, correlated by reqId
```

Zero npm dependencies: the runtime is a CNB workspace, so installing packages
just adds build time and network risk. Node 22+ native `fetch` / `AbortSignal` /
web streams cover everything; tests use `node:test`.

## 3. Request lifecycle

```
client ──POST /v1/chat/completions──▶ server.mjs
  ① OPTIONS → 204 (CORS: Authorization/Content-Type only)
  ② auth: Bearer PROXY_KEY (required env, no default) → fail count → over cap = 429
  ③ read body: 4 MiB cap (over = 413), invalid JSON = 400
  ④ proxy.mjs: fetch upstream (forced stream:true)
      · connect timeout 15s (AbortSignal.timeout)
      · client res 'close' → abort upstream → stop burning credits
  ⑤a stream:  SSE passed through chunk by chunk; res destroyed → cancel reader
  ⑤b non-stream: sse.mjs parses each event → content / tool_calls (incremental
      merge) / usage / finish_reason → assembled into a full chat.completion
  ⑥ log.mjs: one JSON line {reqId, path, status, ms, tokens}
```

### Aggregation details

The non-stream aggregator is a small state machine, not a naive
"concatenate delta.content":

- `delta.content` → concatenated
- `delta.tool_calls[i]` → merged by index: `id`/`type`/`function.name` set on
  first sight, `function.arguments` string-appended
- `delta.reasoning_content` (DeepSeek/GLM-style) → concatenated into
  `message.reasoning_content` (non-standard but preserves information)
- `usage` → passed through if any chunk carries it (upstream usually sends it on
  the final chunk); otherwise zeros with `usage_estimated: true`
- `finish_reason` → last non-null value, default `stop`
- `id`/`model`/`created` → upstream values win
- comment/heartbeat lines (`: keep-alive`) → ignored

## 4. Self-healing address (keepalive)

Three pieces, no long-lived CNB token in the loop:

| Component | Where | Credential | Job |
|-----------|-------|-----------|-----|
| keepalive cron (`.cnb.yml` crontab */5) | CNB | temporary `CNB_TOKEN` (per-run) | no running workspace → start; fixed domain dead 2 rounds → re-register, else stop+start |
| self-register (`deploy/start.sh` → relay `/ops/register`) | workspace → relay | `REG_TOKEN` (secrets repo) | on boot, report `CNB_VSCODE_PROXY_URI`; relay rewrites the nginx upstream map + reloads (idempotent) |
| relay (`deploy/cnb-register.py` + nginx) | your VPS | `REG_TOKEN` | validate the reported URI, atomically switch the upstream map, `nginx -t` then reload, rollback on failure |

Because a workspace restart both drifts the subdomain **and** re-runs
`start.sh`, self-registration closes the loop without human intervention. The
relay only ever knows "the current subdomain"; it holds no CNB token.

See [DEPLOY.md](DEPLOY.md) for the relay/nginx/systemd setup.

## 5. Tests

`test/proxy.test.mjs` starts a local mock upstream (never hits the real API) and
covers: auth pass/fail + rate limit, body limits (413) and invalid JSON (400),
streaming passthrough, non-stream aggregation (content + incremental tool_calls +
usage + finish_reason), client-abort cancellation, upstream 500 passthrough,
connect timeout → 504, stream stall → idle watchdog, routing (`/health`,
`/v1/models`, 404). Run with `node --test`.

## 6. Non-goals

- No multi-tenant / multi-key quota management (single key is enough for a
  personal gateway).
- No TypeScript / build chain (zero-dependency principle).
- No local daemon (being 100% cloud is the whole point).
- No attempt to bypass platform recycling (respect the platform's rules).
