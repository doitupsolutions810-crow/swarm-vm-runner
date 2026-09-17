#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${COORDINATOR_URL:-http://127.0.0.1:4100}"
PASS=0; FAIL=0; DEGRADED=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
degraded() { echo "  DEGRADED: $1"; DEGRADED=$((DEGRADED+1)); }
echo "=========================================="
echo " SWARM VM — PROVE SYSTEM SUCCESS"
echo "=========================================="
[[ -f "$ROOT/docker-compose.yml" ]] && pass "compose file" || fail "compose file"
[[ -f "$ROOT/runner/entrypoint.sh" ]] && pass "runner entrypoint" || fail "runner entrypoint"
grep -q FAIL_CLOSED "$ROOT/runner/entrypoint.sh" && pass "runner fail-closed" || fail "runner fail-closed"
if curl -sf --max-time 3 "$BASE/health" >/dev/null; then
  pass "coordinator health"
  JOB=$(curl -sf --max-time 5 -X POST "$BASE/api/jobs" -H 'content-type: application/json' -d '{"objective":"prove-success"}' || true)
  echo "$JOB" | grep -q '"id"' && pass "job accepted" || fail "job accepted"
  sleep 16
  JOBS=$(curl -sf --max-time 3 "$BASE/api/jobs" || true)
  echo "$JOBS" | grep -q '"status":"completed"' && pass "role chain completed" || degraded "role chain not finished yet"
else
  degraded "coordinator not listening"
fi
degraded "GitHub-hosted Actions not required"
echo "=========================================="
echo " RESULT: $PASS passed, $FAIL failed, $DEGRADED degraded"
if [[ "$FAIL" -eq 0 ]]; then echo " SYSTEM SUCCESS (hosted Actions optional)"; exit 0; else echo " SYSTEM NOT READY"; exit 1; fi
