# REVOCATION PROTOCOL — Signed KILL Event
**Cycle 12 | swarm-vm-runner emergent-compile | 2026-10-31**

## Purpose
The first time a self-hosted runner claims a real job, the compile crosses
from simulation into irreversible execution. This protocol defines the undo
path: a signed KILL event that any authorized party can issue to terminate
a running job before its side effects commit.

## Event Format
```json
{
  "event": "KILL",
  "job_id": "<github-job-id>",
  "run_id": "<github-run-id>",
  "repo": "<owner/repo>",
  "issued_by": "<actor>",
  "issued_at": "<ISO-8601-UTC>",
  "reason": "<free-text>",
  "nonce": "<64-hex>",
  "signature": "<hmac-sha256>"
}
```

## Signing
- Key: `CYCLE12_REVOCATION_KEY` environment variable (never committed).
- Algorithm: HMAC-SHA256 over the canonical JSON with `signature` field
  removed, keys sorted lexicographically.
- Verification: recompute HMAC, constant-time compare. Mismatch → reject.

## Ledger
- Append-only file: `revocation_ledger.jsonl`, one event per line.
- Each entry carries the previous entry's SHA-256 as `prev_sha`.
- Genesis entry: `prev_sha` is the empty string.
- Monotonicity check on every append: reject if `prev_sha` doesn't match.

## Tamper Rejection
- Reordered entries break the hash chain → ledger invalid.
- Modified payload breaks the HMAC → event rejected.
- Duplicate nonce → rejected (replay protection).
- Clock skew beyond ±300 seconds on `issued_at` → rejected.

## Execution Path
1. Watcher polls `revocation_ledger.jsonl` every 2 seconds.
2. On valid KILL for an active job: SIGTERM the runner subprocess,
   then SIGKILL after 10 seconds if still alive.
3. Record termination in ledger with `event: TERMINATED`.
4. Post a comment on the GitHub run with the KILL event ID.

## Self-Test Results (cycle 12)
- Valid KILL event: VERIFIED
- Tampered signature: REJECTED
- Reordered ledger: REJECTED
- Replay nonce: REJECTED
- All four paths fail-closed as designed.
