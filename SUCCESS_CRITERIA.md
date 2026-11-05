# Swarm VM success criteria

Required success does **not** include GitHub-hosted runners.

## Required

1. `docker compose up` starts coordinator + four role workers + redis.
2. `GET /health` returns `{ ok: true }`.
3. `POST /api/jobs` with an objective is accepted (202).
4. Role chain debugger → coder → tester → governance can complete without in-process eval.
5. Runner entrypoint fail-closed if `GITHUB_RUNNER_TOKEN` or `GITHUB_REPOSITORY` is missing.

The acceptance command `./scripts/prove-success.sh` is fail-closed. It requires all six
core Compose services to be running, `/health` to report both coordinator and Redis
ready, and the unique job created by the proof to complete with the exact ordered
role chain debugger → coder → tester → governance. An unrelated completed job does
not satisfy the gate. The target job has a bounded 120-second completion window;
a missing coordinator, missing worker, or incomplete chain is NOT READY.

## Degraded (allowed)

6. No self-hosted runner registered yet.
7. GitHub-hosted `runner_id: 0` on ubuntu-* labels.
8. Content host / vm-maintain profiles off.

## Optional

9. Ephemeral runner Idle in repo Settings → Actions → Runners.
10. Second replica via docker-compose.runner-scale.yml.

Prove: `./scripts/prove-success.sh`
