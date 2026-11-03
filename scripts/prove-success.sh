#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${COORDINATOR_URL:-http://127.0.0.1:4100}"
POLL_SECONDS="${PROVE_SUCCESS_POLL_SECONDS:-20}"
INTERVAL_SECONDS="${PROVE_SUCCESS_INTERVAL_SECONDS:-1}"
PASS=0; FAIL=0; DEGRADED=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
degraded() { echo "  DEGRADED: $1"; DEGRADED=$((DEGRADED+1)); }
echo "=========================================="
echo " SWARM VM — LOCAL EXECUTION PROOF"
echo "=========================================="
[[ -f "$ROOT/docker-compose.yml" ]] && pass "compose file" || fail "compose file"
[[ -f "$ROOT/runner/entrypoint.sh" ]] && pass "runner entrypoint" || fail "runner entrypoint"
grep -q FAIL_CLOSED "$ROOT/runner/entrypoint.sh" && pass "runner fail-closed" || fail "runner fail-closed"

if [[ ${#SWARM_API_TOKEN:-0} -lt 32 || ${#SWARM_READ_TOKEN:-0} -lt 32 ]]; then
  fail "SWARM_API_TOKEN and SWARM_READ_TOKEN must each be at least 32 characters"
elif curl -fsS --max-time 3 "$BASE/health" >/dev/null; then
  pass "coordinator health"
  JOB="$(curl -fsS --max-time 5 -X POST "$BASE/api/jobs" \
    -H "Authorization: Bearer $SWARM_API_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"objective":"prove-success"}')" || {
      fail "job submission failed"
      JOB=""
    }
  JOB_ID=""
  if [[ -n "$JOB" ]]; then
    JOB_ID="$(printf '%s' "$JOB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(typeof j.id!=="string"||!j.id)process.exit(2);process.stdout.write(j.id)}catch{process.exit(2)}})')" || true
  fi
  if [[ -n "$JOB_ID" ]]; then
    pass "job accepted: $JOB_ID"
    DEADLINE=$((SECONDS + POLL_SECONDS))
    FINAL_STATUS="unknown"
    while (( SECONDS < DEADLINE )); do
      JOBS="$(curl -fsS --max-time 3 -H "Authorization: Bearer $SWARM_READ_TOKEN" "$BASE/api/jobs" || true)"
      FINAL_STATUS="$(printf '%s' "$JOBS" | node -e '
        let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
          try {
            const doc=JSON.parse(s);
            const jobs=Array.isArray(doc.jobs)?doc.jobs:[];
            const j=jobs.find(x=>x.id===process.argv[1]);
            if(!j){process.stdout.write("missing");return;}
            const expected=["debugger","coder","tester","governance"];
            const events=Array.isArray(j.events)?j.events:[];
            const allPassed=events.length===expected.length &&
              expected.every((role,i)=>events[i].role===role && events[i].status==="passed");
            if(j.status==="completed" && allPassed) process.stdout.write("success");
            else if(j.status==="failed") process.stdout.write("failed");
            else if(j.status==="completed") process.stdout.write("degraded");
            else process.stdout.write(j.status||"unknown");
          } catch { process.stdout.write("invalid"); }
        });' "$JOB_ID" 2>/dev/null || echo "invalid")"
      case "$FINAL_STATUS" in
        success) pass "exact submitted job completed all mandatory roles"; break ;;
        failed|degraded|missing|invalid) degraded "submitted job state: $FINAL_STATUS"; break ;;
      esac
      sleep "$INTERVAL_SECONDS"
    done
    if [[ "$FINAL_STATUS" != "success" ]]; then
      degraded "submitted job did not meet all success criteria (final=$FINAL_STATUS)"
    fi
  else
    fail "job submission did not return a valid job ID"
  fi
else
  degraded "coordinator not listening"
fi

echo "=========================================="
echo " RESULT: $PASS passed, $FAIL failed, $DEGRADED degraded"
if [[ "$FAIL" -eq 0 && "$DEGRADED" -eq 0 ]]; then
  echo " LOCAL EXECUTION PROOF PASSED (GitHub CI is a separate gate)"
  exit 0
fi
echo " SYSTEM NOT READY"
exit 1
