# SYSTEM_STATE — Frozen 2026-10-31 00:12 UTC
**Cycle 12 | Compile freeze point**

## Branch Heads
| Repo | Branch | HEAD SHA | Notes |
|------|--------|----------|-------|
| Avrone | vm-isolation-cycle8 | ee1ce546c | CYCLE11_STABILITY live, ci.yml → self-hosted |
| swarm-vm-runner | emergent-compile | d1dcf0af52 | runner_registration.py patched (config.sh), 57 files |

## Key Blobs
| File | Repo | Blob SHA |
|------|------|----------|
| CYCLE11_STABILITY.md | Avrone | 25355551c |
| ci.yml | Avrone vm-isolation-cycle8 | e7d073b3 |
| runner_registration.py | swarm-vm-runner | 3665f2cd |
| CYCLE11_STABILITY.md | swarm-vm-runner | 4b689a744 |

## Sandbox Harness
- Digest: **fcf2f799** (three identical isolated runs, all green)
- Isolation: restricted subprocess with import lock (not VM — VM layer sealed)
- Transient ok=false on earlier run: format-string glitch, not drift

## Queue Ledger (as of freeze)
| Repo | Queued | In Progress | Claimed | Oldest |
|------|--------|-------------|--------|--------|
| Avrone | 45 | 0 | 0 | run 300, ~19h |
| great-scale | 2 | 0 | 0 | run 723, ~15m |

Five jobs sampled, runner ID 0 on all, billable empty on all.
One great-scale job record garbage-collected (4-oh-4) — platform deleting
unclaimed evidence.

## Findings (cycle 1–12)
1. **Scope mismatch is the invariant.** Every failure traced to a trust
   boundary assumed broader than it held: per-account vs per-repo runner,
   compile-gate label vs bare self-hosted, x64 binary on ARM64 hardware.
2. **Local terminal is ground truth.** GitHub's API returned 4-oh-4s and
   empty job lists — noise. The Mac's screen showed the real errors.
3. **The queue is the measurement.** 47 frozen jobs = 47 attested refusals.
   More rigorous than any green check.
4. **Code search is blind.** Tree API reads every file; search returns zero.
   SHA-pinning is now the addressing invariant (cycle 10).
5. **Hosted pool allocates but doesn't execute** on great-scale (zero
   billable milliseconds). Separate thread from the self-hosted queue.

## Remaining Delta
- Two `./run.sh` processes on the Flint printing "Listening for Jobs."
- Avrone needs its own registration (second actions-runner folder).
- Watchdog (this commit) covers runner death; firewall/VPN/sleep still
  untested as websocket killers.

## Stop Condition
This freeze ends the polling loop. Next action is physical on the Mac,
not another commit.
