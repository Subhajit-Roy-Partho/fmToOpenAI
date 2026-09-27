#!/bin/bash
# afm-openai-shim lifecycle: start/stop/restart/status.
# pidfile in /tmp (survives repo moves), logs to this dir.
# Also manages the `fm serve` upstream (:1976): `start` auto-launches it when
# down (nohup, log fm-serve.log in repo dir), `stop` tears down only
# shim-started upstreams (ownership tracked via FM_FLAG — a user-owned
# `fm serve` is never touched), `status` reports upstream state too.
# usage: ./shim.sh {start|stop|restart|status}  [PORT default 1977]
# env: AFM_UPSTREAM_PORT (default 1976), AFM_UPSTREAM (default
#      http://127.0.0.1:$AFM_UPSTREAM_PORT/v1) — overrides exist for testing
#      the managed lifecycle without touching the live :1976.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:+$1}"
CMD="${2:-$1}"
# allow both `./shim.sh start` and `./shim.sh start 1977`
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then PORT="$1"; CMD="${2:-status}"; else PORT="${2:-${AFM_SHIM_PORT:-1977}}"; CMD="${1:-status}"; fi
PIDFILE="/tmp/afm-openai-shim.${PORT}.pid"
LOG="$DIR/shim.${PORT}.log"
# Cluster go-live (Phase 2): default 3 workers sharing :PORT via the Node
# cluster scheduler (single shared listener; `status` shows the count).
# Override per-call, e.g. `FM_WORKERS=1 ./shim.sh restart`.
: "${FM_WORKERS:=3}"
export FM_WORKERS

is_up() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

# --- `fm serve` upstream lifecycle (stdlib/shell only) ---
UP_PORT="${AFM_UPSTREAM_PORT:-1976}"
UP_BASE="${AFM_UPSTREAM:-http://127.0.0.1:$UP_PORT/v1}"
FM_LOG="$DIR/fm-serve.log"
FM_FLAG="/tmp/afm-openai-shim.fm-managed"

upstream_healthy() { curl -s -m 3 "$UP_BASE/models" >/dev/null 2>&1; }
upstream_managed() { [[ -f "$FM_FLAG" ]] && kill -0 "$(cat "$FM_FLAG" 2>/dev/null)" 2>/dev/null; }

upstream_status() {
  if upstream_healthy; then
    if upstream_managed; then echo "upstream :$UP_PORT up (managed, pid $(cat "$FM_FLAG"))"
    else echo "upstream :$UP_PORT up (user-owned)"; fi
  else echo "upstream :$UP_PORT down"; fi
}

ensure_upstream() {
  if upstream_healthy; then
    if upstream_managed; then echo "upstream :$UP_PORT already healthy (managed, pid $(cat "$FM_FLAG"))"
    else echo "upstream :$UP_PORT already healthy (user-owned, leaving alone)"; fi
    return 0
  fi
  rm -f "$FM_FLAG"  # stale flag from a dead upstream — never adopt a stranger
  echo "upstream :$UP_PORT down — launching 'fm serve' (log $FM_LOG)"
  if [ "$UP_PORT" = "1976" ]; then
    # NB: `exec` is load-bearing — without it, bash (3.x) keeps the
    # backgrounded `cd && nohup …` subshell alive as the server's parent and
    # $! records the parent, not the server (teardown would miss).
    (cd "$DIR" && exec nohup fm serve >>"$FM_LOG" 2>&1 & echo $! >"$FM_FLAG")
  else
    (cd "$DIR" && exec nohup fm serve --port "$UP_PORT" >>"$FM_LOG" 2>&1 & echo $! >"$FM_FLAG")
  fi
  for ((i = 0; i < 60; i++)); do
    if upstream_healthy; then echo "upstream :$UP_PORT healthy (managed, pid $(cat "$FM_FLAG"))"; return 0; fi
    if ! kill -0 "$(cat "$FM_FLAG" 2>/dev/null)" 2>/dev/null; then
      echo "'fm serve' died during startup — see $FM_LOG"; rm -f "$FM_FLAG"; return 1
    fi
    sleep 1
  done
  echo "'fm serve' never became healthy on :$UP_PORT after 60s — see $FM_LOG"
  kill "$(cat "$FM_FLAG" 2>/dev/null)" 2>/dev/null; rm -f "$FM_FLAG"
  return 1
}

stop_upstream() {
  [ -f "$FM_FLAG" ] || return 0
  MPID="$(cat "$FM_FLAG" 2>/dev/null)"
  if [ -n "$MPID" ] && kill -0 "$MPID" 2>/dev/null; then
    # Ownership guard against pid reuse: kill only if the pid still looks like
    # the server we launched — either its command line matches, or it holds
    # the upstream port (name match fails for wrappers whose ps line hides
    # argv[0], e.g. macOS `ps` showing the interpreter path).
    if ps -p "$MPID" -o args= 2>/dev/null | grep -q "fm serve"; then
      WHY="command-line match"
    elif lsof -p "$MPID" 2>/dev/null | grep -q "TCP .*:$UP_PORT (LISTEN)"; then
      WHY="holds :$UP_PORT listener"
    else
      WHY=""
    fi
    if [ -n "$WHY" ]; then
      echo "stopping managed upstream 'fm serve' (pid $MPID, $WHY)"
      kill "$MPID" 2>/dev/null
      for ((i = 0; i < 20; i++)); do kill -0 "$MPID" 2>/dev/null || break; sleep 0.5; done
      if kill -0 "$MPID" 2>/dev/null; then
        echo "managed upstream pid $MPID ignoring TERM — pkill 'fm serve'"
        pkill -f "fm serve" 2>/dev/null; sleep 1
      fi
    else
      echo "pid $MPID is no longer 'fm serve' (pid reuse?) — leaving it alone"
    fi
  else
    echo "managed upstream pid ${MPID:-unknown} already gone — leaving :$UP_PORT alone"
  fi
  rm -f "$FM_FLAG"
}

case "$CMD" in
  start)
    # Upstream first: `fm serve` must be healthy before the shim binds, and a
    # failed upstream start aborts (no orphaned shim without a backend).
    ensure_upstream || exit 1
    # Hygiene (§10): `restart` used to leave orphans — the pidfile held the
    # lsof listener pid, but crashed/duplicate starters piled up, giving
    # EADDRINUSE + stacked `listening` lines in shim.${PORT}.log. So:
    # if pidfile is alive but extra listeners share the port, reap orphans;
    # if pidfile is stale/missing, kill the pidfile pid AND pkill lingering
    # `node shim.js` listeners, then wait for the port to free before binding.
    if is_up; then
      PID="$(cat "$PIDFILE")"
      NPID="$(lsof -ti :"$PORT" 2>/dev/null | wc -l | tr -d ' ')"
      if [ "$NPID" = "1" ]; then echo "shim :$PORT already running (pid $PID)"; exit 0; fi
      echo "shim :$PORT has $NPID listeners (expected 1) — reaping orphans"
      for P in $(lsof -ti :"$PORT" 2>/dev/null); do [ "$P" != "$PID" ] && kill "$P" 2>/dev/null; done
      sleep 0.5
      echo "shim :$PORT already running (pid $PID)"; exit 0
    fi
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"; fi
    pkill -f "node shim.js" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      lsof -ti :"$PORT" >/dev/null 2>&1 || break
      sleep 0.5
    done
    LEFTOVER="$(lsof -ti :"$PORT" 2>/dev/null | head -1)"
    if [ -n "$LEFTOVER" ]; then kill -9 "$LEFTOVER" 2>/dev/null; sleep 0.5; fi
    rm -f "$PIDFILE"
    (cd "$DIR" && FM_WORKERS="$FM_WORKERS" AFM_SHIM_PORT="$PORT" nohup node shim.js >>"$LOG" 2>&1 &)
    # pidfile = actual TCP listener (nohup/subshell pids are unreliable)
    PID=""
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      PID="$(lsof -ti :"$PORT" 2>/dev/null | head -1)"
      [ -n "$PID" ] && break
      sleep 0.5
    done
    sleep 1
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && curl -s -m 3 "http://127.0.0.1:$PORT/health" >/dev/null; then
      echo "$PID" >"$PIDFILE"
      echo "shim started :$PORT (pid $PID, log $LOG)"
      NLISTEN="$(lsof -ti :"$PORT" 2>/dev/null | wc -l | tr -d ' ')"
      # Cluster mode (FM_WORKERS>1): the primary still holds the single shared
      # :PORT socket (workers take connections via IPC), so exactly 1 listener
      # is expected in both modes — worker count is visible via `status`.
      if [ "$NLISTEN" != "1" ]; then echo "WARN: $NLISTEN listeners on :$PORT (expected 1): $(lsof -ti :$PORT 2>/dev/null | tr '\n' ' ')"; exit 1
      else echo "single listener verified :$PORT (pid $PID)"; fi
    else
      echo "shim :$PORT failed to start — see $LOG"; rm -f "$PIDFILE"; exit 1
    fi
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"; fi
    sleep 0.5
    stop_upstream  # only tears down shim-started `fm serve`; user-owned survives
    if lsof -ti :"$PORT" >/dev/null 2>&1; then echo "shim :$PORT still listening after stop (pids: $(lsof -ti :$PORT 2>/dev/null | tr '\n' ' ')) — run start to reap"; exit 1
    else echo "shim :$PORT stopped, port free"; fi
    ;;
  restart) "$0" stop "$PORT"; "$0" start "$PORT" ;;
  status)
    upstream_status
    if is_up; then
      PID="$(cat "$PIDFILE")"
      KIDS="$(pgrep -P "$PID" 2>/dev/null | wc -l | tr -d ' ')"
      [ -z "$KIDS" ] && KIDS=0
      NLISTEN="$(lsof -ti :"$PORT" 2>/dev/null | wc -l | tr -d ' ')"
      echo "shim :$PORT up (pid $PID, workers $KIDS, listeners ${NLISTEN:-0})"
      curl -s -m 3 "http://127.0.0.1:$PORT/health"; echo
    else echo "shim :$PORT down"; exit 1; fi
    ;;
  *) echo "usage: $0 {start|stop|restart|status} [port]"; exit 2 ;;
esac
