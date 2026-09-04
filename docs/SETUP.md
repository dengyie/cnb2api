# Setting up cnb2api on CNB (from zero)

This is the CNB side of the setup: get the repo into your org, set one key,
boot the workspace, and verify. The optional fixed-domain relay lives on your
own VPS — see [DEPLOY.md](DEPLOY.md) for that part.

Time budget: ~5 minutes on the fast path, ~10 with the secrets repo.

## Fast path (3 steps)

For a private fork, the only value you must supply is your own `PROXY_KEY` —
the keepalive needs no edits because it reads the built-in `CNB_REPO_SLUG`:

1. **Fork this repo into your org, private** (or create a private repo and
   push the contents). A private fork keeps your key inlined in `.cnb.yml`
   safely — it's your own repo.
2. **Set your key**: in `.cnb.yml`, replace the placeholder in the vscode
   stage's `env:` block, e.g. with `openssl rand -hex 24` output. Never ship
   the placeholder value itself.
3. **Start 云开发 (cloud dev)** on the repo page. The build log prints your
   endpoint:

   ```
   PROXY_URI=https://<subdomain>-9001.cnb.run
   ```

   That's your base URL (`/v1`) and the key from step 2 is your API key.
   The 5-minute keepalive cron starts on the next cron tick — nothing else
   to configure.

Outgrown the fast path (team use, or you want the fixed domain)? Switch to
the secrets-repo flow below — delete the inline `env:` line, uncomment
`imports:`, and follow sections 2–3.

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

The fast path above IS this step (private fork). You only need the sections
below if you skipped it or want the secrets-repo flow.

## 2. Create the secrets repo

CNB can inject env vars into pipelines from another repo's YAML file via
`imports:`. Keeping every real credential in its own repo — rather than
inlined in the code repo — is the cleaner layout for teams or public forks.

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

| Where | What to set |
|---|---|
| both `imports:` stanzas | `https://cnb.cool/your-org/cnb2api-secrets/-/blob/main/proxy.yml` |
| vscode `env:` | delete the inline `PROXY_KEY` (it now comes from the secrets repo) |
| (secrets repo) | `PROXY_MODELS: "model-x,model-y"` if your models differ |

`REPO` for the keepalive needs no edit either way — it reads the built-in
`CNB_REPO_SLUG`. Note the keepalive cron lives under the `main:` branch key —
if your default branch is not `main`, either rename the key or the branch, or
the cron never fires.

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
