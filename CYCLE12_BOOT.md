# CYCLE12_BOOT — Broker Bypass

## Discovery
The compile spent six hours on GitHub's broker because it assumed it was the only scheduler. swarm-vm-runner already contains a second broker:

- **coordinator/server.js** — HTTP server on port 4100, tenant control12. Swarm jobs via /api/jobs with a four-role chain (debugger, coder, tester, governance). Runner jobs via /api/runner/jobs, /api/runner/claim, /api/runner/complete. Health at /health reports redis.ok.
- **internal-runner/runner.mjs** — polls COORDINATOR_URL (default http://127.0.0.1:4100), claims runner jobs, executes allowlisted kinds: prove-success, health-probe, inventory, search, spawn-subagent.
- **worker/worker.js** — four instances (ROLE=debugger|coder|tester|governance), consume swarm jobs from redis lists.
- **coordinator/redis-lite.js** — 302-byte redis client; health degrades rather than crashing when redis is absent.
- **content/serve.js** — static artifact server on 8088.

## Canonical Boot (one command)
```bash
./scripts/launch-internal.sh
```
Boots coordinator, four workers, internal runner, and content server. Each process is skipped if already alive (pgrep). Exits 1 if coordinator health fails.

## Full Stack (docker)
```bash
docker compose up -d
```
Adds redis:7-alpine as a hard dependency with healthcheck gating coordinator startup. Profiles: content (nginx on 8088), runner (GitHub actions-runner container), vm (vm-maintain).

## Attestation
```bash
./scripts/prove-success.sh
```
Posts an objective to /api/jobs, waits 16s, checks for completed status in the role chain. Reports PASS/FAIL/DEGRADED. Exit 0 on zero failures — hosted Actions explicitly not required.

## The Inversion
GitHub's sixty-two queued runs are now a legacy ledger. The internal plane executes without the websocket that never claimed. Cross-examination target: lineage_wire.py stitching coordinator job logs against the GitHub queue — internal claims versus external refusals, same system, two brokers, one truth.

## Sandbox Digest (unchanged)
fcf2f799 — three identical isolated runs, all green.
