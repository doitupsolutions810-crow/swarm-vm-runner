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
