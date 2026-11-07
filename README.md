# Swarm VM + self-hosted runner

Environment for the CONTROL12 / Trinity sub-agent swarm:

- coordinator + four role workers (debugger, coder, tester, governance)
- static content host for artifacts
- GitHub Actions ephemeral self-hosted runner
- optional VM maintain profile

Hosted ubuntu pools currently fail with runner_id 0. Jobs should use `[self-hosted, linux, control12]`.

```bash
cp .env.example .env
docker compose up --build
curl -s http://127.0.0.1:4100/health

docker compose --profile runner --profile content up --build
```


## Coordinator authentication

The coordinator keeps `/health` public for container health checks. Every `/api/*`
route requires a bearer token with a narrow purpose: `SWARM_API_TOKEN` may create
jobs, `SWARM_READ_TOKEN` may read jobs/search, `SWARM_RUNNER_TOKEN` may claim,
renew, and complete internal-runner jobs, and each worker event requires its own role token:
`SWARM_DEBUGGER_TOKEN`, `SWARM_CODER_TOKEN`, `SWARM_TESTER_TOKEN`, or
`SWARM_GOVERNANCE_TOKEN`. Worker containers receive only the read token and
their own role token. Do not reuse secrets across capabilities.

Generate seven independent values and place them in the local `.env` file:

```bash
for name in SWARM_API_TOKEN SWARM_READ_TOKEN SWARM_RUNNER_TOKEN SWARM_DEBUGGER_TOKEN SWARM_CODER_TOKEN SWARM_TESTER_TOKEN SWARM_GOVERNANCE_TOKEN; do
  printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
done
```

The coordinator persists job and runner state to an fsync-backed JSONL journal on the mounted `swarm-data` volume, compacts it after 500 records by default, recovers queued work after restart, and rejects stale runner claim tokens. It rejects oversized or malformed request bodies, enforces the
debugger → coder → tester → governance transition order, rejects duplicate or
terminal-state reports, and binds runner completion to the runner that claimed
the job. Internal runner claims use a renewable bounded lease. The runner heartbeats
at `RUNNER_HEARTBEAT_MS` (default 10 seconds) against a `RUNNER_LEASE_MS` (default
30 seconds); the heartbeat must be less than half the lease duration. A failed
renewal cancels the active task and the runner does not submit completion with a
stale claim token. Runner polling is single-flight, so one process never claims
multiple jobs concurrently. The `spawn-subagent` action uses a durable
`Idempotency-Key` derived from the parent runner job ID, so replay after an
ambiguous network outcome returns the same child job instead of creating a
duplicate. When child creation times out, returns a retryable server response,
or its response cannot be parsed, the parent is deliberately left incomplete:
its heartbeat stops, the lease expires, and the next claimant retries the
identical key. Definite authorization or idempotency conflicts are completed
as failures instead of being retried forever. The `/api/jobs` idempotency
contract rejects reuse of a key with a different normalized objective and
persists the key in the coordinator journal.

The internal runner reads the settings `RUNNER_LEASE_MS`, `RUNNER_HEARTBEAT_MS`,
and `POLL_MS` from the Compose environment. Keep the heartbeat safely below
half the lease duration. The host path selected by `SWARM_WORKSPACE_HOST_PATH`
(default `.`) is mounted read-only at `/workspace`; the scanner is configured
to search there rather than the image directory. It skips hidden folders,
`.git`, secrets/credentials directories, private-key file types, and files over
1 MiB, with traversal capped at 6 directory levels and 500 files per search.
The runner container runs as an unprivileged numeric UID, has a read-only
root filesystem, a small no-exec `/tmp`, no Linux capabilities, and
`no-new-privileges`. It is limited to 64 processes, 256 MiB of memory, and one
CPU. No host Docker socket is mounted.

These controls harden the coordinator protocol; they do not make the optional
GitHub Actions runner safe for untrusted pull-request code.

## AVRONE signed integration boundary

The coordinator exposes `POST /api/integration/enqueue` for the first signed cross-repository action. It authenticates the cross-repository caller using an RFC 8785 / Ed25519 AVRONE envelope (no shared coordinator bearer token), a separately signed Capability Authority capability for the exact `Execute:swarm.jobs:POST` right, and a mounted Swarm receipt-signing private key. The signed `payload` includes both `objective` and `action: { type: "Execute", resource: "swarm.jobs", method: "POST" }`; action metadata outside the payload is ignored. It verifies issuer, audience, payload digest, expiry, capability signature and exact method before accepting a job. Each role transition also requires a Grok Bot Ed25519 evidence signature bound to the exact job and role; the coordinator rejects unsigned or mismatched worker claims. The job, idempotency ledger and signed receipt are persisted in one fsync-backed journal record; exact retries return the original receipt, while conflicting reuse of either identifier is rejected. On restart, receipt signatures and the complete previous-receipt chain are re-verified before the service starts.

Trust roots are configured with `SWARM_AVRONE_ISSUER_PUBLIC_KEY_FILE`, `SWARM_CAPABILITY_AUTHORITY_PUBLIC_KEY_B64`, `SWARM_RECEIPT_SIGNING_PRIVATE_KEY_FILE`, `SWARM_AVRONE_ISSUER`, and `SWARM_SERVICE_IDENTITY`. Key files must be mounted inside the coordinator container from an independent secret store; the path variables refer to container paths. Do not commit keys or trust keys supplied in requests. Without all trust material the integration endpoint returns 503. The Capability Authority currently lacks authenticated delegated issuance to a target workload (tracked in its issue #16), so a correctly audience-bound production capability cannot yet be minted through its current API.

**Specialist execution bridge:** the four role workers now call Grok Bot's
authenticated `POST /api/swarm/execute` endpoint. Grok Bot runs each role through
its real agent runtime and hardened terminal sandbox, captures actual terminal
results, hashes changed Git files, and returns Ed25519-signed evidence. Coder
success requires changed artifacts; Tester success requires a successful test
command; Governance requires an explicit approval plus passing artifact and
test checks. The coordinator verifies the pinned executor identity and
role-specific evidence schema before accepting the role transition.

This bridge is disabled until the matching executor public key, executor ID,
and four independent role-specific executor tokens are configured. Create the
shared Docker network once with `docker network create swarm-integration`.
Provision the private key only in Grok Bot's `./secrets` directory and copy
only the public key into this repository's `./secrets/grok-swarm-executor.pub`.
Set `SWARM_EXECUTOR_PUBLIC_KEY_HOST_FILE=./secrets/grok-swarm-executor.pub`,
then start the Swarm stack with both `docker-compose.yml` and
`docker-compose.swarm.yml`. See the Grok Bot README's “Signed Swarm specialist
execution bridge” section for the matching key and token setup.

The terminal sandbox is a constrained Docker container, not a disposable VM.
Per-job workspaces persist and require a retention/cleanup policy. This bridge
does not yet provide distributed atomic leases across multiple coordinator
instances, cancellation fencing for external side effects, or a production
multi-tenant isolation guarantee. Keep the PR in draft until the exact-head
contract suite and a live four-role job pass.

Run the coordinator contract suite with:

```bash
cd coordinator && npm test
```

## Security boundary (important)

The optional `runner` profile is **not approved for untrusted pull-request code**.
The Compose runner intentionally has no `/var/run/docker.sock` mount and no
Docker-host control token. This prevents a workflow from using the host Docker
daemon as a privilege-escalation path. Consequently, jobs that require Docker
builds or sibling-container control are unsupported by this profile.

Do not attach this runner to the AVRONE pull-request workflow merely to work
around hosted-runner allocation failures. First provision a disposable VM per
job (or an equivalently isolated execution boundary), issue a short-lived
ephemeral registration token at launch, destroy the VM after completion, and
prove cleanup and secret isolation. Use a separate trusted workflow for
operator-approved jobs only. A runner label is routing metadata, not a security
boundary.


## Running the integrated specialist workers

Create the shared network once before starting either compose project:

```bash
docker network create swarm-integration
```

Start Grok Bot and Swarm VM Runner on that network. The worker services use
`http://grok-bot:3000/api/swarm/execute`; all four worker containers must join
the external `swarm-integration` network. The base compose file now declares
that external network explicitly, and the Swarm overlay mounts the pinned
executor public key into the coordinator.

The Grok Bot private signing key must remain in Grok Bot's local
`secrets/swarm-executor-ed25519.pem`; only the public key belongs in Swarm
Runner's `secrets/grok-swarm-executor.pub`. Use four separate 32-byte-or-longer
executor tokens, identical in the two `.env` files. Never commit either key or
the local secret directory.


### Run the live four-role acceptance smoke test

After Grok Bot and all four specialist workers are healthy, provision
`SWARM_SMOKE_REPOSITORY` and `SWARM_SMOKE_BRANCH` in the Swarm Runner
environment. Configure the same repository and branch as
`SWARM_DEFAULT_REPOSITORY` and `SWARM_DEFAULT_BRANCH` in Grok Bot. The
repository must be readable by the sandbox. The smoke task creates two uniquely
named untracked test artifacts in the isolated per-job checkout; it does not
commit or push them.

Run:

```bash
docker compose exec coordinator npm run smoke:swarm
```

The smoke runner creates a real task, waits for Debugger → Coder → Tester →
Governance, verifies all four Ed25519 signatures against the pinned public key,
checks tenant/job/executor identity, validates artifact digests and successful
test evidence, and prints a compact acceptance receipt. A zero exit code is
the live acceptance result. This does not replace the multi-instance lease,
workspace cleanup, or production isolation gates.
