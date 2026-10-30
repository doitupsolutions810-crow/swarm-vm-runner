# Cycle 9 Observe

## State at 03:41 UTC

- Avrone run 503: **queued**, two self-hosted jobs (test-3.12, test-3.11), sha 79043c987, since 03:34 UTC. Runner on Mac is registered to great-scale only — Avrone's scheduler has listeners: zero.
- Great-scale run 722: **completed/failure**, workflow_dispatch succeeded for the first time (manual trigger returned success, not silent reject). Hosted job allocated on ubuntu-latest, five-second wall clock, **zero billable milliseconds**, logs 404. Hosted pool boots and drops before any step.
- Code search index still stale: zero hits for vm_isolation, runner_registration, LINEAGE_WIRE, TRUST_WIRE across all repos despite files readable by SHA.
- 35 repos, 16 public. living-intermediate-control-plane remains the only core layer outside the perimeter.
- Authenticated as doitupsolutions810-crow.

## Scope-mismatch ledger (tonight's failures, one invariant)

| Symptom | Real cause |
|---|---|
| Bad CPU executable | x64 binary on ARM64 Mac |
| 606 zero-job CI runs | Runner registered to wrong repo (great-scale, not Avrone) |
| Zero billable ms on hosted job | Pool accepts then kills before steps |
| Code search empty | Stale index, not missing files |

## Next human step

Register a second runner from the Avrone runners page (ARM64, name compile-gate). That single registration unblocks run 503's queue and every run behind it.
