# Setting up cnb2api on CNB (from zero)

This is the CNB side of the setup: create the repo, wire the secrets, boot the
workspace, and verify. The optional fixed-domain relay lives on your own VPS —
see [DEPLOY.md](DEPLOY.md) for that part.

Time budget: ~10 minutes if you already have a CNB account with AI credits.

## Prerequisites

- A [cnb.cool](https://cnb.cool) account whose org has **AI credits** enabled
  (the "天才程序员" / built-in AI offering). Without it the upstream endpoint
  `https://api.cnb.cool/<org>/<repo>/-/ai/chat/completions` returns errors.
- Know which models your account exposes. Set `PROXY_MODELS` to that list —
  the repo default is `deepseek-v4-flash,glm-5.3-flash,kimi-k3` (what our
  account advertises; the gateway currently routes all three to the same
  upstream model) and requests naming an unavailable model will be rejected.

**Quota & compute economics** (measured on our deployment):
- **Compute**: a workspace pinned at `runner.cpus: 2` burns 48 core-hours/day;
  24/7 uptime for a 30-day month is ~1,440 core-hours, within the free
  1,600 core-hour pool. The 5-minute keepalive cron adds only a few
  core-hours/month.
- **AI credits**: 500/month base for a verified org, more with the *hello-cnb*
  bonus. Each response's `usage` reports the exact `credit` it cost — fresh
  requests measured at roughly ~23k tokens per credit; cached prompts cost far
  less.
Watch usage under *org → settings → usage*.

## 1. Create the code repo

Create a **private** repo under your org (e.g. `your-org/cnb2api`) and push the
contents of this project to it. Private is fine — CNB builds private repos the
same way.

## 2. Create the secrets repo

CNB can inject env vars into pipelines from another repo's YAML file via
`imports:`. Keep every real credential there, never in the code repo.

1. Create a second **private** repo, e.g. `your-org/cnb2api-secrets`.
2. Add a `proxy.yml` at its root:

   ```yaml
   PROXY_KEY: "sk-your-long-random-api-key"     # what your clients send
   REG_TOKEN: "your-long-random-shared-secret"  # relay auth, if you use the relay
   REGISTER_URL: "https://ai.example.com/ops/register"  # optional, relay only
   ```

3. Restrict who may import it: repo settings → protect/import scope →
   `allow_slugs: your-org/cnb2api`. Now only the code repo can pull these
   values.
4. Generate the values with, e.g., `openssl rand -hex 24`.

## 3. Edit `.cnb.yml` in the code repo

Three spots, all marked with comments:

| Where | What to set |
|---|---|
| `main:` → keepalive `env:` | `REPO: your-org/cnb2api`; `FIXED:` your `https://…/health` URL (or comment the line out to skip the HTTP probe) |
| both `imports:` stanzas | `https://cnb.cool/your-org/cnb2api-secrets/-/blob/main/proxy.yml` |
| (secrets repo) | `PROXY_MODELS: "model-x,model-y"` if your models differ |

Note the keepalive cron lives under the `main:` branch key — if your default
branch is not `main`, either rename the key or the branch, or the cron never
fires.

## 4. Boot the workspace

Push, then on the repo page start **云原生构建 / cloud dev environment**
(the vscode workspace). The build log of the `start-ai-proxy` stage prints:

```
===== proxy self-check: health OK =====
...
PROXY_URI=https://<subdomain>-9001.cnb.run
```

That `PROXY_URI` is a working (if drifting) endpoint: try it immediately with

```bash
curl https://<subdomain>-9001.cnb.run/v1/models \
  -H "Authorization: Bearer $PROXY_KEY"
```

If you deployed the relay, the log also shows
`===== registered upstream to relay =====` and your fixed domain is live.

## 5. Verify, end to end

```bash
# health (no auth)
curl https://ai.example.com/health
# expect {"status":"ok",...}

# models (auth)
curl https://ai.example.com/v1/models -H "Authorization: Bearer $PROXY_KEY"

# a real completion
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_KEY" -H "Content-Type: application/json" \
  -d '{"model":"<one-of-your-models>","messages":[{"role":"user","content":"hi"}]}'
```

Point any OpenAI client at `baseURL: https://ai.example.com/v1` with
`apiKey: $PROXY_KEY` and you're done.

## Troubleshooting quick table

| Symptom | Likely cause → fix |
|---|---|
| Build log `register skipped (REGISTER_URL / REG_TOKEN / PROXY_URI missing)` | Secrets repo not imported (`.cnb.yml` `imports:`), or names differ from `proxy.yml` |
| `POST /ops/register` → 403 | `REG_TOKEN` in the secrets repo ≠ `/root/.cnb/register.env` on the relay |
| Fixed domain → 502/504 right after a restart | Workspace was recycled and re-registration is still in flight; the keepalive cron re-registers within ~5 min — or check `journalctl -u cnb-register` |
| Fixed domain → 413 with an nginx HTML page | Relay nginx lacks `client_max_body_size` (see [DEPLOY.md](DEPLOY.md)); the proxy itself returns a JSON 413 |
| `/v1/chat/completions` → 400/404 mentioning the model | `PROXY_MODELS` lists names your account doesn't expose — fix the list in the secrets repo |
| Workspace never stays alive | Cron key not on your default branch, or you edited `.cnb.yml` on a non-`main` branch |
