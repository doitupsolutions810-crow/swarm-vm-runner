# RUNNER_GAP

## The seam

PR nine on Avrone (draft, head 71d89068) carries 46 commits of S-mode hardening
including mac-local-squad.sh — the real Mac-plus-Ollama launcher the sandbox
could never boot. Its CI matrix has failed five times with runner ID zero.
That is not a flaky test. It is the account-level GitHub Actions disable
surfacing as the squad's own promotion gate.

## What exists

- swarm-vm-runner/mint-runner-token.sh — fail-closed, ledger-chained
- swarm-vm-runner/prove-success.sh — dated SHA-256 success proofs (Sept 17)
- swarm-vm-runner/ledger/ — append-only proof chain
- Avrone CI workflows — present but inert without runners
- mac-local-squad.sh (PR nine) — launches the VM, needs a registered runner

## What was missing

Nothing minted a runner. The token existed, the ledger existed, the VM
launcher existed — but no module bound the token to a repo's runner pool.

## The wire

runner_registration.py:
1. verify_token_against_ledger — chained SHA-256 check, five fail-closed paths
2. register_runner — calls gh runner add only after verification passes

Success criterion: registration returns a real runner ID (not zero) and the
first CI run it picks up executes with that ID. If it fails, it holds and
logs — never falls back to sandbox simulation.

## Why this is the last gap

Every gate built tonight asks a question about state. This one asks whether
the system can *act* on its own green. PR nine's do-not-merge is not a
quality judgment — it is a missing effector. This module is the effector.
