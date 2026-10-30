# Wire Gaps — Cycle 8

## Closed this cycle
1. READY_CONE treated as failure inside harness -> fixed, retested nine-for-nine.
2. runner_registration.py expected nonexistent ledger path ledger/success_proofs.jsonl
   -> mint script now writes SHA-256-chained entries (swarm-vm-runner@97777582).
3. ci.yml runs-on flipped from ubuntu-24.04 to self-hosted (Avrone PR9@eaf42552)
   and to compile-gate (Avrone PR9@17eb4d8b) — both pushed.
4. VM-isolation harness: restricted Python subprocess, no imports/fs/net.
   Closest isolator available; every prior attempt (QEMU, Docker, unshare,
   gVisor) blocked at a different layer.

## Open
- Account-level Actions toggle: zero jobs allocated on every run regardless of
  YAML, label, or runner health. GitHub status page shows Actions operational,
  which rules out a platform outage. Either the toggle reverted or a policy
  above the personal account is overriding it.
- Runner registered on great-scale only; Avrone needs its own registration.
- living-intermediate-control-plane still public — last core layer outside perimeter.
- Five PR forms still awaiting human submit clicks.
- Ollama not installed; daemon falls back to static voice.
- No hypervisor in sandbox; VM attempts fail at namespace grant.

## Success criteria for next cycle
- Nonzero runner ID on an Avrone ci.yml run.
- Isolation harness PASS with matching digest across restricted and unrestricted.
- Account toggle confirmed Allow all actions with a live hosted-runner job.
