# AVRONE + Grok Bot + Swarm execution bridge

## Required shared network

Create the external Docker network once:

```sh
docker network create swarm-integration
```

Both Grok Bot and Swarm Compose projects attach their service containers to this network. Swarm workers call Grok Bot at `http://grok-bot:3000/api/swarm/execute`; the host-published Grok Bot port is loopback-only.

## Trust keys and token

Use separate Ed25519 key pairs for AVRONE envelope signing, Capability Authority capability signing, Swarm receipt signing, and Grok Bot execution evidence signing. The Grok Bot executor key pair is dedicated to role evidence:

- Private key mounted only into Grok Bot as `/run/secrets/grok-swarm-executor-ed25519.pem`.
- Public key mounted only into the Swarm coordinator as `/run/secrets/grok-swarm-executor.pub`.

Set the same randomly generated `SWARM_EXECUTOR_TOKEN` in both Grok Bot and Swarm. Never commit key files or the token. The Swarm coordinator additionally requires AVRONE issuer public key, Swarm receipt private key, and pinned Capability Authority public key.

## Start order

1. Provision all secret files and environment variables.
2. Start Grok Bot with its key overlay:
   `docker compose -f docker-compose.yml -f docker-compose.swarm.yml up -d`.
3. Start Swarm with its trust-root overlay:
   `docker compose -f docker-compose.yml -f docker-compose.swarm.yml up -d`.
4. Verify Grok Bot `/health`, then submit a signed AVRONE envelope to Swarm `/api/integration/enqueue`.
5. Observe the ordered debugger → coder → tester → governance transitions. Every transition must carry Grok Bot's signed evidence. A missing executor, bad signature, failed tool, malformed report or unavailable provider must leave the job pending or mark it failed; it must never pass.

## Important limitations

- Capability Authority issue #16 must be completed before AVRONE can securely obtain a capability whose audience is the Swarm workload. Do not use caller override.
- The Swarm endpoint's signed enqueue path is a durable queue acceptance receipt, not proof of completed work.
- Grok Bot role evidence is signed and records tool exit codes/output digests, but governance still must independently verify the reported artifact hashes and test results.
- No live Docker end-to-end run has been performed in this environment. The unit tests are local; deployment requires the shared network, secret mounts and a functioning Docker host.
