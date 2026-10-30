# Round 21 Fix

## What broke

1. **runner_registration.py** defaulted to `tmp/emergent-system/attested-history/index.jsonl` and had no awareness of `ledger/success_proofs.jsonl` — the path Round 21's audit named. A mint that wrote to the right file would still fail verification because the verifier was looking at the wrong one.

2. **mint-runner-token.sh** minted a GitHub registration token and printed it, but wrote nothing to any ledger. The token existed in memory only — unattested, unverifiable, and gone the moment the shell closed. runner_registration.py's HOLD_UNLINEAGED path was not a safety net; it was the only path, because the mint side never produced a record.

3. **register_runner** invoked `gh runner add`, which is not the documented self-hosted registration sequence. The canonical flow is download → tar → `./config.sh --url --token`, then `./run.sh`. `gh runner add` is a thin wrapper that can 404 when the repo's runner API surface isn't what it expects (as seen in the 404 on POST /repos/.../runner-registration/rest).

## What changed

- **mint-runner-token.sh**: after minting, appends a SHA-256-chained ledger entry to `ledger/success_proofs.jsonl` (or `$ATTESTED_HISTORY_LEDGER_DIR/success_proofs.jsonl`). The entry's payload_hash is the hash of the token itself, parent-linked to the prior HEAD. The token is no longer ephemeral — it is now a first-class attested event.

- **runner_registration.py** (Avrone squad branch): ledger path resolution now tries a candidate list — env var, then `ledger/success_proofs.jsonl`, then the legacy tmp path — and accepts the first readable file. No single hardcoded path can silently orphan a mint.

- **Registration invocation**: documented alongside config.sh as the supported sequence; `gh runner add` retained as a fallback but flagged HOLD_UNREGISTERED on 404 rather than treated as a hard error, since the 404 may reflect API surface drift rather than a bad token.

## The invariant

A token that cannot be verified against the chain cannot register a runner. A mint that writes no ledger entry produces a token that cannot be verified. Both sides of the seam now speak the same language: hash, parent, digest, line.
