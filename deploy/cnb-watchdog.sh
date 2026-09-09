#!/bin/bash
# cnb2api external watchdog script (v5.2 dual-watchdog architecture: silent fallback recovery)
#
# Usage:
#   Run this via host crontab (e.g. `*/5 * * * * /path/to/cnb-watchdog.sh`)
#   on your relay VPS / server to probe your fixed domain.
#
# Environment variables (or define them in /etc/cnb-watchdog.env):
#   CNB_REPO          CNB repo slug, e.g. "my-org/ai-proxy" (required for fallback)
#   FIXED_URL         Full health URL, e.g. "https://ai.example.com/health"
#   FALLBACK_TOKEN    Personal access token or file path containing token (optional)
#   TG_BOT_TOKEN      Telegram Bot token for failure alerts (optional)
#   TG_CHAT_ID        Telegram Chat ID for alerts (optional)
#   CNB_QUOTA_FILE    Optional quota snapshot path to check staleness (e.g. /www/cnb-quota.json)
#   CNB_SYNC_SCRIPT   Optional fallback sync script to run when quota is stale (> 900s)
#
set -uo pipefail

ENV_FILE="${CNB_WATCHDOG_ENV:-/etc/cnb-watchdog.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

LOG="${CNB_WATCHDOG_LOG:-/var/log/cnb-watchdog.log}"
STATE_FILE="${CNB_WATCHDOG_STATE:-/tmp/cnb-watchdog-fails}"
REPO="${CNB_REPO:-}"
FIXED="${FIXED_URL:-http://127.0.0.1:9001/health}"
THRESH_FALLBACK="${CNB_THRESH_FALLBACK:-3}"  # 3 fails (15 min): trigger silent fallback
THRESH_ALERT="${CNB_THRESH_ALERT:-4}"        # 4 fails (20 min): alert only if fallback failed
TG_COOLDOWN="${TG_COOLDOWN:-3600}"          # Telegram alert cooldown in seconds
FB_COOLDOWN="${FB_COOLDOWN:-1800}"          # Fallback dispatch cooldown (30 min)
QUOTA_FILE="${CNB_QUOTA_FILE:-}"
SYNC_SCRIPT="${CNB_SYNC_SCRIPT:-}"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
[ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ] && mv -f "$LOG" "$LOG.1"

tg_send() {
  [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ] || return 0
  curl -s --max-time 10 "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_CHAT_ID}" \
      --data-urlencode "text=$1" >/dev/null \
    || log "WARN: telegram push failed"
}

try_fallback_start() {
  local token="${FALLBACK_TOKEN:-}"
  [ -f "$token" ] && token=$(cat "$token" 2>/dev/null || true)
  if [ -n "$token" ] && [ -n "$REPO" ]; then
    local last_fb=0
    [ -s "${STATE_FILE}.fallback" ] && last_fb=$(cat "${STATE_FILE}.fallback" 2>/dev/null)
    last_fb=${last_fb:-0}
    local now=$(date +%s)
    if [ $((now - last_fb)) -lt "$FB_COOLDOWN" ]; then
      log "FALLBACK: cooling down ($((now - last_fb))s < ${FB_COOLDOWN}s), skip duplicate start"
      return 0
    fi

    log "FALLBACK: triggering workspace/start via OpenAPI..."
    local resp
    resp=$(curl -s --max-time 30 -X POST "https://api.cnb.cool/$REPO/-/workspace/start" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -d '{"branch":"main"}' || true)
    log "FALLBACK: response: $resp"

    # Only set cooldown lock if response contains valid instance identifier
    case "$resp" in
      *'"sn":'*)
        echo "$now" > "${STATE_FILE}.fallback"
        log "FALLBACK: workspace launch dispatched successfully, cooling down ${FB_COOLDOWN}s"
        return 0
        ;;
      *)
        log "WARN: fallback workspace/start returned unexpected response (not cooling down)"
        return 1
        ;;
    esac
  fi
  return 1
}

H=$(curl -s --max-time 20 "$FIXED" || true)
case "$H" in
  *'"status":"ok"'*)
    echo 0 > "$STATE_FILE"
    if [ -f "${STATE_FILE}.alerted" ]; then
      log "RECOVERED: fixed domain is healthy again (notified user)"
      rm -f "${STATE_FILE}.alerted" "${STATE_FILE}.tg" "${STATE_FILE}.fallback"
      tg_send "✅ cnb2api is healthy again: $FIXED passed check"
    else
      # Recovered silently without bothering user
      log "OK: healthy (silent)"
      rm -f "${STATE_FILE}.fallback" 2>/dev/null || true
    fi

    # Fallback sync: if quota snapshot is stale (> 15 min due to CI cron dormancy),
    # auto-refresh via external sync script if configured
    if [ -n "$QUOTA_FILE" ] && [ -f "$QUOTA_FILE" ] && [ -n "$SYNC_SCRIPT" ] && [ -x "$SYNC_SCRIPT" ]; then
      now_ts=$(date +%s)
      mtime=$(stat -c %Y "$QUOTA_FILE" 2>/dev/null || stat -f %m "$QUOTA_FILE" 2>/dev/null || echo 0)
      if [ $((now_ts - mtime)) -ge 900 ]; then
        log "SYNC: quota stale ($((now_ts - mtime))s >= 900s), executing fallback sync script"
        "$SYNC_SCRIPT" >/dev/null 2>&1 || true
      fi
    fi
    exit 0
    ;;
  *)
    FAILS=$(( $(cat "$STATE_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "$FAILS" > "$STATE_FILE"

    # Step 1: At 15 min, dispatch silent fallback start to give it a recovery window
    if [ "$FAILS" -ge "$THRESH_FALLBACK" ]; then
      try_fallback_start >/dev/null 2>&1 || true
    fi

    # Step 2: At >=20 min, if still failing, both self-healing and fallback failed -> alert human!
    if [ "$FAILS" -ge "$THRESH_ALERT" ]; then
      last=0
      [ -s "${STATE_FILE}.tg" ] && last=$(cat "${STATE_FILE}.tg" 2>/dev/null)
      last=${last:-0}
      now=$(date +%s)
      if [ $((now - last)) -ge "$TG_COOLDOWN" ]; then
        echo "$now" > "${STATE_FILE}.tg"
        touch "${STATE_FILE}.alerted"
        log "ALERT: failing x$FAILS (~$((FAILS * 5)) min) — fallback did not recover, need human"
        tg_send "🔴 cnb2api endpoint persistent failure ~$((FAILS * 5)) min ($FIXED). Both cron self-healing and external fallback failed to recover."
      else
        log "ALERT: failing x$FAILS (alert cooldown)"
      fi
    else
      log "WARN: fail #$FAILS"
    fi
    ;;
esac
