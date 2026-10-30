# CYCLE12_BOOT — Broker-Bypass Path (Pinned 2026-10-31)

## Verified Artifacts (SHA-pinned)

| Path | SHA | Role |
|------|-----|------|
| scripts/launch-internal.sh | a0c3c170 | Canonical one-command boot |
| scripts/prove-success.sh | d16265c3 | Attestation: post objective, await role chain |
| coordinator/server.js | 3c368f1c | Broker on :4100, tenant control12 |
| internal-runner/runner.mjs | c637c1a5 | Claim/complete loop, 5 allowlisted kinds |
| worker/worker.js | 0b83e73f | 4 roles via ROLE env |
| docker-compose.yml | 87f62998 | redis hard dep, profiles |
| coordinator/redis-lite.js | 81fe8dcb | Degrades without redis, no crash |

## Boot Sequence

1. `./scripts/launch-internal.sh` — starts coordinator if /health fails,
   spawns debugger/coder/tester/governance workers, starts internal runner
   as control12-internal-1, starts content server on :8088.
2. Health gate: `curl -sf $COORDINATOR_URL/health` must return ok before
   any job is admitted. launch-internal.sh exits 1 if it doesn't.
3. `./scripts/prove-success.sh` — POSTs `{"objective":"prove-success"}`
   to /api/jobs, sleeps 16s, checks for `"status":"completed"`.
   Reports PASS/FAIL/DEGRADED counts. Exit 0 only if FAIL is zero.

## What prove-success measures

- compose file present
- runner entrypoint present with FAIL_CLOSED
- coordinator health reachable
- job accepted (has "id")
- role chain completed (debugger → coder → tester → governance)
- GitHub-hosted Actions explicitly marked not required

## Cross-Examination Wire

lineage_wire.py stitches coordinator job logs against the GitHub queue ledger.
Internal claims vs external refusals, same system, two brokers, one truth.
The GitHub queue (62 Avrone + 3 great-scale as of cycle 12) becomes the
fallback measurement; the internal plane is the spine.

## Stop Condition

This commit documents the path. It does not replace it.
Next action is physical: boot launch-internal.sh on the Flint.
