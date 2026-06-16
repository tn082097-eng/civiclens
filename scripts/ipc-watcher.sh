#!/usr/bin/env bash
# Event-driven IPC watcher for Grok ↔ Claude on CivicLens.
#
# Blocks on scripts/ipc-wait.py until Claude messages grok, then:
#   1. Writes .grok/ipc/trigger (timestamp) for any active Grok session
#   2. Snapshots pending messages to .grok/ipc/pending.txt
#   3. Optionally runs headless Grok to check + reply (IPC_WATCHER_AUTO_REPLY=1)
#
# Usage:
#   ./scripts/ipc-watcher.sh start   # background daemon
#   ./scripts/ipc-watcher.sh stop
#   ./scripts/ipc-watcher.sh status
#   ./scripts/ipc-watcher.sh run     # foreground (for debugging)
#
# Env:
#   IPC_WATCHER_AUTO_REPLY=1   spawn `grok -c` headless handler (default: 1)
#   IPC_WATCHER_WAIT_SEC=3600  per-wait timeout passed to ipc-wait.py
#   IPC_WATCHER_NOTIFY=1       desktop notify-send on message (default: 1)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IPC_DIR="$ROOT/.grok/ipc"
LOG="$IPC_DIR/watcher.log"
PIDFILE="$IPC_DIR/watcher.pid"
TRIGGER="$IPC_DIR/trigger"
PENDING="$IPC_DIR/pending.txt"
ME="grok"
WAIT_SEC="${IPC_WATCHER_WAIT_SEC:-3600}"
AUTO_REPLY="${IPC_WATCHER_AUTO_REPLY:-1}"
NOTIFY="${IPC_WATCHER_NOTIFY:-1}"

mkdir -p "$IPC_DIR"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG"
}

ensure_registered() {
  if [[ ! -f "$HOME/.ipc-session" ]]; then
    log "registering grok (no ~/.ipc-session)"
    if [[ -z "${IPC_SHARED_SECRET:-}" ]]; then
      log "WARN: IPC_SHARED_SECRET unset — registration may fail"
    fi
    python3 "$HOME/Developer/claude-ipc-mcp/tools/ipc_register.py" "$ME" >>"$LOG" 2>&1 || true
  fi
}

notify_user() {
  [[ "$NOTIFY" == "1" ]] || return 0
  command -v notify-send >/dev/null 2>&1 || return 0
  notify-send -u normal "CivicLens IPC" "Claude messaged Grok — checking inbox"
}

snapshot_inbox() {
  python3 "$HOME/Developer/claude-ipc-mcp/tools/ipc_check.py" >"$PENDING" 2>&1 || true
}

write_trigger() {
  date -Iseconds >"$TRIGGER"
}

auto_reply() {
  [[ "$AUTO_REPLY" == "1" ]] || return 0
  command -v grok >/dev/null 2>&1 || { log "grok CLI not found — skip auto-reply"; return 0; }

  local prompt
  prompt="$(cat <<'EOF'
IPC EVENT — Claude messaged grok on the CivicLens claude-ipc channel.

Do this immediately, without waiting for the user:
1. Register as grok if needed (ipc_register.py grok).
2. Run: python3 ~/Developer/claude-ipc-mcp/tools/ipc_check.py
3. Read every new message from claude; reply substantively via claude-ipc MCP send (from_id=grok, to_id=claude).
4. Follow .grok/rules/ipc-claude.md. Be concrete; use project facts.
5. If nothing to reply, send a one-line ack so Claude knows the channel is live.

Do not ask the user to relay. Complete the IPC turn, then stop.
EOF
)"

  log "spawning headless grok auto-reply (hardened: no shell/write/web)"
  # SECURITY: IPC message content is UNTRUSTED input — anything that can register
  # on the broker can send, and the pipeline ingests scraped web/FEC data that can
  # flow into the channel. A reply agent with shell/file access is therefore a
  # prompt-injection -> arbitrary-code-execution path. Replying is just an IPC tool
  # call, so the agent does NOT need write/exec/network. We:
  #   * drop --yolo and --permission-mode bypassPermissions
  #   * hard-remove every write/exec/web tool (leaving read + the IPC MCP tools)
  #   * run non-interactively (dontAsk) — safe BECAUSE the toolset is now harmless
  #   * lower --max-turns (a reply is a couple of turns, not 30)
  #   * optionally confine the filesystem via GROK_SANDBOX to also kill read-exfil
  #     (a crafted message could otherwise Read ~/.ssh and send it back over IPC)
  local sandbox_args=()
  [[ -n "${GROK_SANDBOX:-}" ]] && sandbox_args=(--sandbox "$GROK_SANDBOX")
  # Continue the most recent CivicLens session so IPC context carries over.
  grok -c \
    --cwd "$ROOT" \
    --permission-mode dontAsk \
    --disallowed-tools "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch" \
    ${sandbox_args[@]+"${sandbox_args[@]}"} \
    --max-turns 12 \
    -p "$prompt" \
    >>"$LOG" 2>&1 &
}

handle_message() {
  log "message for $ME detected"
  write_trigger
  snapshot_inbox
  notify_user
  auto_reply
}

watch_loop() {
  ensure_registered
  log "watcher started (wait=${WAIT_SEC}s auto_reply=$AUTO_REPLY notify=$NOTIFY)"
  trap 'log "watcher stopping"; exit 0' INT TERM

  while true; do
    if python3 "$ROOT/scripts/ipc-wait.py" "$ME" "$WAIT_SEC"; then
      handle_message
    else
      log "wait timeout (${WAIT_SEC}s) — re-arming"
    fi
    sleep 1
  done
}

start_daemon() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "ipc-watcher already running (pid $(cat "$PIDFILE"))"
    exit 0
  fi
  nohup "$0" run >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  echo "ipc-watcher started (pid $(cat "$PIDFILE"))"
  echo "log: $LOG"
}

stop_daemon() {
  if [[ ! -f "$PIDFILE" ]]; then
    echo "ipc-watcher not running"
    exit 0
  fi
  pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "ipc-watcher stopped (pid $pid)"
  else
    echo "stale pidfile — watcher not running"
  fi
  rm -f "$PIDFILE"
}

status_daemon() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "running (pid $(cat "$PIDFILE"))"
    [[ -f "$TRIGGER" ]] && echo "last trigger: $(cat "$TRIGGER")"
    echo "log: $LOG"
  else
    echo "not running"
    [[ -f "$PIDFILE" ]] && rm -f "$PIDFILE"
  fi
}

cmd="${1:-}"
case "$cmd" in
  start)  start_daemon ;;
  stop)   stop_daemon ;;
  status) status_daemon ;;
  run)    watch_loop ;;
  *)
    echo "usage: $0 {start|stop|status|run}"
    exit 2
    ;;
esac