#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp
export COORDINATOR_URL="${COORDINATOR_URL:-http://127.0.0.1:4100}"
export PORT="${PORT:-4100}"
export CONTENT_PORT="${CONTENT_PORT:-8088}"
alive() { curl -sf --max-time 1 "$1" >/dev/null; }
if ! alive "$COORDINATOR_URL/health"; then
  node "$ROOT/coordinator/server.js" >"$LOG/swarm-coord.log" 2>&1 &
  echo $! >"$LOG/swarm-coord.pid"
  sleep 0.4
fi
if ! pgrep -f 'worker/worker.js' >/dev/null 2>&1; then
  for role in debugger coder tester governance; do
    ROLE=$role node "$ROOT/worker/worker.js" >"$LOG/swarm-$role.log" 2>&1 &
  done
fi
if ! pgrep -f 'internal-runner/runner.js' >/dev/null 2>&1; then
  INTERNAL_RUNNER_NAME="${INTERNAL_RUNNER_NAME:-control12-internal-1}" \
    node "$ROOT/internal-runner/runner.js" >"$LOG/swarm-internal.log" 2>&1 &
  echo $! >"$LOG/swarm-internal.pid"
fi
if ! curl -sf --max-time 1 "http://127.0.0.1:${CONTENT_PORT}/" >/dev/null; then
  node --input-type=module "$ROOT/content/serve.js" >"$LOG/swarm-content.log" 2>&1 &
  echo $! >"$LOG/swarm-content.pid"
fi
alive "$COORDINATOR_URL/health" || { echo "coordinator failed"; exit 1; }
echo "launched coordinator=$COORDINATOR_URL content=http://127.0.0.1:${CONTENT_PORT}/"
curl -sf "$COORDINATOR_URL/health"
echo
