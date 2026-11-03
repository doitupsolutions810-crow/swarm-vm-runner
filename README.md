# Swarm VM + self-hosted runner

Environment for the CONTROL12 / Trinity sub-agent swarm:

- coordinator + four role workers (debugger, coder, tester, governance)
- static content host for artifacts
- Redis
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
route requires a bearer token. Set `SWARM_API_TOKEN` to a unique random value of
at least 32 characters. Each worker event route additionally requires its own
role credential: `SWARM_DEBUGGER_TOKEN`, `SWARM_CODER_TOKEN`,
`SWARM_TESTER_TOKEN`, and `SWARM_GOVERNANCE_TOKEN`. Do not reuse one token
across roles.

Generate five independent values and place them in the local `.env` file:

```bash
for name in SWARM_API_TOKEN SWARM_DEBUGGER_TOKEN SWARM_CODER_TOKEN SWARM_TESTER_TOKEN SWARM_GOVERNANCE_TOKEN; do
  printf '%s=%s\\n' "$name" "$(openssl rand -hex 32)"
done
```

The coordinator rejects oversized or malformed request bodies, enforces the
debugger → coder → tester → governance transition order, rejects duplicate or
terminal-state reports, and binds runner completion to the runner that claimed
the job. These controls harden the coordinator protocol; they do not make the
optional GitHub Actions runner safe for untrusted pull-request code.

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
