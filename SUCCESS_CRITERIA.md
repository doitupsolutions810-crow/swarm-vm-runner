# Swarm VM success criteria

## Coordinator protocol (required)

1. Compose starts coordinator + four role workers with the persistent state volume.
2. `GET /health` returns HTTP 200.
3. Authenticated `POST /api/jobs` accepts a bounded objective and returns a unique ID.
4. Read, coordinator-write, runner, and four worker-role credentials are distinct and fail closed when missing or reused.
5. Job events are accepted only in debugger → coder → tester → governance order.
6. Duplicate, out-of-order, malformed, oversized, invalid-UTF-8, and post-terminal events are rejected.
7. Internal runner completion is bound to the runner that claimed the job.

The coordinator state journal is fsync-backed, compacted, and replayed on restart; interrupted final appends are ignored, while malformed interior records fail startup. Runner claims are leased and carry fresh claim tokens after restart.\n\n## Actual execution (not yet satisfied)

The current four worker containers are protocol stubs. They intentionally report a
failed event until a real executor is configured. A successful HTTP handshake or
role event is not evidence that the task was executed. Do not label the system
production-ready or attach it as a trusted AVRONE executor until each role returns
bounded, independently verifiable execution evidence.

## Degraded / explicitly not production-approved

- No ephemeral self-hosted runner is registered.
- GitHub-hosted runner allocation failures are not bypassed with an unsafe shared runner.
- The optional runner profile is not approved for untrusted pull-request code.
- Docker builds, persistent browser use, and actual model-driven task execution require separate live validation.

Run local protocol checks with `cd coordinator && npm test`.
Run the exact-job local proof with `./scripts/prove-success.sh`. It must never be
reported as GitHub CI success.
