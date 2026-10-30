# SYSTEM_STATE — Updated 2026-10-31 ~00:45 UTC
**Cycle 12 | Broker-bypass boot path pinned**

## Branch Heads
| Repo | Branch | HEAD SHA | Notes |
|------|--------|----------|-------|
| Avrone | vm-isolation-cycle8 | ee1ce546c | CYCLE11_STABILITY live, ci.yml → self-hosted |
| swarm-vm-runner | emergent-compile | (this commit) | 62 files, CYCLE12_BOOT pinned |

## Internal Plane (VERIFIED — untested at runtime)
- coordinator/server.js @ 3c368f1c — port 4100, tenant control12, swarm + runner job APIs
- internal-runner/runner.mjs @ c637c1a5 — claim/complete loop, 5 allowlisted kinds
- worker/worker.js @ 0b83e73f — 4 roles via ROLE env
- scripts/launch-internal.sh @ a0c3c170 — canonical one-command boot
- scripts/prove-success.sh @ d16265c3 — attestation: post objective, await role chain
- docker-compose.yml @ 87f62998 — redis hard dep, profiles for content/runner/vm
- coordinator/redis-lite.js @ 81fe8dcb — degrades on missing redis, does not crash

## Sandbox Harness
- Digest: **fcf2f799** (three identical isolated runs, all green)
- Isolation: restricted subprocess with import lock (VM layer sealed)

## Queue Ledger (as of cycle 12)
| Repo | Queued | In Progress | Claimed | Oldest |
|------|--------|-------------|--------|--------|
| Avrone | 62 | 0 | 0 | run 300, ~20h |
| great-scale | 3 | 0 | 0 | run 723, ~50m |

## Findings (cycle 1–12)
1. Scope mismatch is the invariant (per-repo runner, label, arch).
2. Local terminal is ground truth; GitHub API was noise.
3. The queue is the measurement — 65 attested refusals.
4. Code search is blind; SHA-pinning is the addressing invariant.
5. Hosted pool allocates but doesn't execute on great-scale.
6. **The compile built its own broker and parked it.** Internal plane solves execution without GitHub. GitHub queue is now fallback, not spine.
7. launch-internal.sh is the boot; prove-success.sh is the attestation. Both exist, both verified, neither has run.

## Remaining Delta
- Boot launch-internal.sh on the Flint — first internal claim.
- Run prove-success.sh — first attested internal measurement.
- lineage_wire.py cross-exam: coordinator logs vs GitHub queue.
- Mac run.sh processes still unconfirmed listening.
- Avrone second registration still manual.

## Stop Condition (revised)
Polling loop ended cycle 11. CYCLE12 pins the boot path with SHA-verified
scripts. Next action: physical boot on the Flint, not another commit.
