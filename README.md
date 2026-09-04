# cnb2api

Turn a [CNB](https://cnb.cool) cloud-workspace **in-network AI endpoint** into a
standard **OpenAI-compatible** API — 100% in the cloud, zero local dependencies,
with a self-healing fixed public address.

CNB's built-in AI credits are only reachable from inside a CNB cloud workspace
(the endpoint requires a pipeline `CNB_TOKEN` and CNB-internal networking). This
project runs a tiny reverse proxy **inside** that workspace and exposes it as a
plain `https://.../v1/chat/completions` endpoint you can point any OpenAI client at.

> Node 22+ · **zero npm dependencies** (native `fetch` / `AbortSignal` / streams) ·
> tests use the built-in `node:test` runner.

## Features

- **OpenAI-compatible**: `/v1/chat/completions` (streaming SSE + non-streaming),
  `/v1/models`, `/health`.
- **Faithful non-stream aggregation**: reassembles `content`, incremental
  `tool_calls`, `reasoning_content`, `usage`, and `finish_reason` from the
  upstream SSE stream into a complete `chat.completion` object.
- **Production-hardened forwarding**: connect timeout, per-stream idle watchdog,
  backpressure handling, and two-way cancellation — a client disconnect aborts
  the upstream so you stop burning credits on an abandoned request.
- **Timing-safe key auth** with a sliding-window failure limiter (429 on abuse).
- **Self-healing address**: the workspace subdomain changes on every restart;
  on boot the workspace self-registers its current URI to a small relay, which
  repoints your fixed domain — so clients keep using one stable URL.
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

## Quick start (local, against a mock upstream)

```bash
node --test        # run the test suite (mock upstream, no real API calls)
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

## Deploy on CNB

1. Fork/create a CNB repo from this project.
2. Put your secrets (`PROXY_KEY`, `REG_TOKEN`, `REGISTER_URL`) in a **private**
   secrets repo and reference it from `.cnb.yml` via `imports:` — do **not**
   commit real values.
3. Edit `.cnb.yml`: set `REPO` to your `org/repo` and (optionally) `FIXED` /
   `REGISTER_URL`.
4. Push, then start the cloud workspace. The build log prints `PROXY_URI=...`.
5. To get one stable public URL, deploy the relay + nginx from
   [docs/DEPLOY.md](docs/DEPLOY.md). Without it you can still use the raw
   `https://<subdomain>-9001.cnb.run/v1` URL (it changes on each restart).

See [`.env.example`](.env.example) for every knob.

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `PROXY_KEY` | — (required) | Bearer key clients must send. No default; refuses to start if missing. |
| `CNB_TOKEN` | — (required) | Upstream token; injected by the CNB pipeline stage. |
| `CNB_REPO_SLUG` | `CNB_BUILD_REPO` | `org/repo` used to build the upstream URL. Auto-filled inside a workspace. |
| `PROXY_MODELS` | `model-a,model-b,model-c` | Comma-separated ids advertised on `/v1/models`. |
| `PROXY_PORT` | `9001` | Listen port. |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `15000` | Upstream connect / first-byte timeout. |
| `PROXY_IDLE_TIMEOUT_MS` | `300000` | Per-stream idle watchdog. |
| `REGISTER_URL` | — (optional) | Relay `/ops/register` endpoint for self-registration. |
| `REG_TOKEN` | — (optional) | Shared secret for self-registration. |
| `UPSTREAM_OVERRIDE` | — | Test-only: point the upstream at a local mock. |

## License

MIT — see [LICENSE](LICENSE).

> Not affiliated with CNB. This is an independent, personal-use compatibility
> shim. Respect the AI provider's and platform's terms of service.
