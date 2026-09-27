#!/bin/bash
# afm-openai-shim lifecycle: start/stop/restart/status.
# pidfile in /tmp (survives repo moves), logs to this dir.
# usage: ./shim.sh {start|stop|restart|status}  [PORT default 1977]
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:+$1}"
CMD="${2:-$1}"
# allow both `./shim.sh start` and `./shim.sh start 1977`
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then PORT="$1"; CMD="${2:-status}"; else PORT="${2:-${AFM_SHIM_PORT:-1977}}"; CMD="${1:-status}"; fi
PIDFILE="/tmp/afm-openai-shim.${PORT}.pid"
LOG="$DIR/shim.${PORT}.log"

is_up() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "$CMD" in
  start)
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
    (cd "$DIR" && AFM_SHIM_PORT="$PORT" nohup node shim.js >>"$LOG" 2>&1 &)
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
    if lsof -ti :"$PORT" >/dev/null 2>&1; then echo "shim :$PORT still listening after stop (pids: $(lsof -ti :$PORT 2>/dev/null | tr '\n' ' ')) — run start to reap"; exit 1
    else echo "shim :$PORT stopped, port free"; fi
    ;;
  restart) "$0" stop "$PORT"; "$0" start "$PORT" ;;
  status)
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
