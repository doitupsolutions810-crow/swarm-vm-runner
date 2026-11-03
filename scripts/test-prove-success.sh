#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
set +e
env -u SWARM_API_TOKEN -u SWARM_READ_TOKEN "$ROOT/scripts/prove-success.sh" >"$OUT" 2>&1
STATUS=$?
set -e
[[ "$STATUS" -eq 1 ]] || { cat "$OUT"; echo "expected fail-closed exit 1, got $STATUS" >&2; exit 1; }
grep -q "SWARM_API_TOKEN and SWARM_READ_TOKEN must each be at least 32 characters" "$OUT"
! grep -q "LOCAL EXECUTION PROOF PASSED" "$OUT"
set +e
PROVE_SUCCESS_POLL_SECONDS=not-a-number "$ROOT/scripts/prove-success.sh" >"$OUT" 2>&1
STATUS=$?
set -e
[[ "$STATUS" -eq 2 ]] || { cat "$OUT"; echo "expected invalid interval exit 2, got $STATUS" >&2; exit 1; }
grep -q "invalid PROVE_SUCCESS_POLL_SECONDS" "$OUT"
echo "PASS: local proof fails closed on missing credentials and invalid timeout settings"
