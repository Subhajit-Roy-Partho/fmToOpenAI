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
    if is_up; then echo "shim :$PORT already running (pid $(cat "$PIDFILE"))"; exit 0; fi
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
    else
      echo "shim :$PORT failed to start — see $LOG"; rm -f "$PIDFILE"; exit 1
    fi
    ;;
  stop)
    if is_up; then kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" && echo "shim :$PORT stopped"; else rm -f "$PIDFILE"; echo "shim :$PORT not running"; fi
    ;;
  restart) "$0" stop "$PORT"; "$0" start "$PORT" ;;
  status)
    if is_up; then echo "shim :$PORT up (pid $(cat "$PIDFILE"))"; curl -s -m 3 "http://127.0.0.1:$PORT/health"; echo
    else echo "shim :$PORT down"; exit 1; fi
    ;;
  *) echo "usage: $0 {start|stop|restart|status} [port]"; exit 2 ;;
esac
