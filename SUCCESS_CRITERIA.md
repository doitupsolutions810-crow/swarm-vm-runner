# Swarm VM success criteria

This repository maintains two independent evidence gates. A local coordinator
proof must never be represented as GitHub CI success, and neither gate alone
authorizes production deployment.

## Local execution proof (required)

1. Docker Compose starts the coordinator, four role workers, and Redis.
2. The coordinator health endpoint returns HTTP 200.
3. A submitted job returns a unique job ID.
4. Events are accepted only in the exact order debugger → coder → tester → governance.
5. Duplicate, out-of-order, malformed, or post-terminal events are rejected.
6. The exact submitted job reaches completed with exactly one passed event for
   each mandatory role.
7. Runner entrypoint fails closed when GITHUB_RUNNER_TOKEN or
   GITHUB_REPOSITORY is missing.

Run: `./scripts/prove-success.sh`

The result is labelled LOCAL EXECUTION PROOF PASSED, never SYSTEM SUCCESS.

## GitHub CI evidence (separate required gate)

- The coordinator Node.js integration tests pass on the hosted CI runner.
- Bash syntax checks pass for operational scripts.
- CI is not inferred from a local proof and must be independently observed in
  the GitHub Actions run for the exact commit.

## Deployment boundary

- Coordinator and content ports bind to loopback by default.
- Expose them only through an explicitly configured authenticated reverse
  proxy or a separately reviewed network policy.
- The self-hosted runner profile is not approved for untrusted pull-request
  code. It has no Docker socket and is not a workaround for hosted runner
  allocation failures.
- A runner label is routing metadata, not an isolation boundary.
