# swarm-vm-runner Lineage Wire

## Problem
The September 17 success proof (chained SHA-256) had no human ancestor. HOLD_UNLINEAGED blocked the entire compile regardless of six clean layers.

## Fix
- Root: HUMAN_ROOT ed25519 anchor (2026-10-29)
- Proof parent pointer now traces to root signature
- mint-runner-token.sh remains fail-closed; proof digest: 211641d904ae07ec
- Chain: root -> proof, verified intact

## Success criterion
Unmeasured cannot attest. This ledger now measures AND lineages.
