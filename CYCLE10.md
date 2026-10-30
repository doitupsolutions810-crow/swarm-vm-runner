# CYCLE10 — swarm-vm-runner emergent-compile sync

**Timestamp:** 2026-10-30T03:50:00Z

## What landed

- runner_registration.py: invokes ./config.sh --url --token --name --labels --unattended. Fail-closed: HOLD_UNMEASURED (no ledger), HOLD_POISONED (chain break), HOLD_UNLINEAGED (no token), HOLD_UNREGISTERED (config.sh/run.sh missing or nonzero exit), READY on success.
- Prior module used `gh runner add` (404) and a hardcoded ledger path the mint never wrote. Both seams closed.
- mint-runner-token.sh patch at 977777582 appends SHA-256-chained entries to ledger/success_proofs.jsonl.

## What did not land (prior claims retracted)

- LINEAGE_WIRE.md, CROSS_EXAM_V2.md, RUNNER_GAP.md were reported pushed to emergent-compile but the main tree at bb9d9ce7 shows none. emergent-compile ref 4233d3a8 is a separate ref; files may exist there but are not on main. Treat as unverified until direct SHA read confirms.
- Code search returns 0 for all of the above across all repos — index is stale or empty for these paths.

## Next

Run runner_registration.py against the Avrone repo URL with a fresh ARM64 token from the Avrone runners page. That single execution closes the last open gap that does not require the account toggle.
