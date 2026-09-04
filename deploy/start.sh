#!/bin/bash
# Workspace boot script, invoked by the vscode stage in .cnb.yml.
# - copies src/ into a stable run dir
# - kills any previous instance (idempotent hot restart)
# - self-checks /health, then self-registers this workspace's port-proxy URI
#   to the fixed-domain relay (REG_TOKEN) so nginx can follow workspace drifts.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PROXY_RUN_DIR:-/workspace/proxy}"
PORT="${PROXY_PORT:-9001}"
# Where to report this workspace's PROXY_URI. Empty -> self-registration is skipped
# (you then point your fixed domain at the workspace URI by hand, or run your own relay).
REGISTER_URL="${REGISTER_URL:-}"

mkdir -p "$RUN_DIR"
cp -f "$SRC_DIR"/src/*.mjs "$RUN_DIR/"

cd "$RUN_DIR"
# Idempotent: kill old instance (workspace hot-restart scenario)
pkill -f "node server.mjs" 2>/dev/null || true
sleep 0.5

nohup node server.mjs > proxy.log 2>&1 &

# Self-check: failed boot, missing key auth, broken routing -> build goes red (visible)
for i in $(seq 1 20); do
  if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "===== proxy self-check: health OK ====="
    curl -s --max-time 2 "http://127.0.0.1:${PORT}/health"; echo
    echo "===== models ====="
    curl -s --max-time 2 "http://127.0.0.1:${PORT}/v1/models"; echo
    echo "PROXY_URI=${CNB_VSCODE_PROXY_URI:-<env missing>}"
    # Self-registration: report this workspace's port-proxy URI to the fixed-domain
    # relay. Failure is non-fatal for the proxy itself (the relay-side monitor will
    # notice the fixed domain going dark and alert).
    if [ -n "${REGISTER_URL:-}" ] && [ -n "${REG_TOKEN:-}" ] && [ -n "${CNB_VSCODE_PROXY_URI:-}" ]; then
      for attempt in 1 2 3; do
        if curl -sf --max-time 10 -X POST "${REGISTER_URL}" \
            -H "X-Reg-Token: $REG_TOKEN" -H "Content-Type: application/json" \
            -d "{\"uri\":\"$CNB_VSCODE_PROXY_URI\"}"; then
          echo "===== registered upstream to relay ====="
          break
        fi
        sleep 5
      done
    else
      echo "===== register skipped (REGISTER_URL / REG_TOKEN / PROXY_URI missing) ====="
    fi
    exit 0
  fi
  sleep 0.5
done

echo "===== proxy self-check FAILED after 10s ====="
tail -50 proxy.log || true
exit 1
