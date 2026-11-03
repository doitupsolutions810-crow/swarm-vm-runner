# AVRONE / Grok Bot / Swarm deployment overlay

The default Compose files remain usable independently, but the real specialist bridge uses the `docker-compose.swarm.yml` overlay in both repositories.

## Shared network

Create once on the Docker host:

```sh
docker network create swarm-integration
```

Grok Bot and the four Swarm workers attach to this external network. Worker containers resolve the Grok service as `grok-bot` and call `http://grok-bot:3000/api/swarm/execute`. The Grok Bot host port is bound to loopback; this worker traffic stays on the internal Docker network.

## Independent keys

Provision four Ed25519 trust relationships outside Git:

- AVRONE issuer private key / Swarm-pinned AVRONE public key.
- Capability Authority private key / AVRONE- and Swarm-pinned CA public key.
- Swarm receipt private key / AVRONE-pinned Swarm receipt public key.
- Grok Bot evidence private key / Swarm-pinned Grok Bot evidence public key.

For the Grok Bot evidence key, create a key pair with OpenSSL and mount the private key into Grok Bot only. Mount the public key into the Swarm coordinator only. Set `SWARM_EXECUTOR_TOKEN` identically in both repositories (32+ random characters). Do not reuse coordinator, runner, role, CA or receipt keys.

Set the host paths in `.env`:
- `SWARM_AVRONE_ISSUER_PUBLIC_KEY_HOST_FILE`
- `SWARM_RECEIPT_SIGNING_PRIVATE_KEY_HOST_FILE`
- `SWARM_EXECUTOR_PUBLIC_KEY_HOST_FILE`

Then run Swarm with the overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.swarm.yml up -d --build
```

In Grok Bot, set `SWARM_EXECUTOR_SIGNING_KEY_HOST_FILE` and run its corresponding overlay. The container paths are fixed by the overlays: `/run/secrets/avrone-issuer.pub`, `/run/secrets/swarm-receipt.pem`, and `/run/secrets/grok-swarm-executor.pub` in Swarm; `/run/secrets/grok-swarm-executor-ed25519.pem` in Grok Bot.

## What a green role event means

A role event is accepted only with an Ed25519 signature from the pinned Grok Bot executor identity, bound to the exact job and role. The evidence includes actual CodeX tool-result events, exit codes, output digests and a role-specific report. Debugger needs diagnosis/reproduction; coder needs changed artifact paths and SHA-256 digests; tester needs real zero-exit test commands; governance needs an independent approval and all checks passing.

Grok Bot caches a completed result in its persistent CodeX ledger using a stable job/role run ID. Swarm persists the signed evidence with the role transition. Provider outage or missing credentials leaves the job queued; unsigned, mismatched or incomplete evidence cannot pass.

## Remaining deployment gates

- Capability Authority issue #16 must implement authenticated capability delegation to the exact Swarm audience. Caller override is not a workaround.
- Provision the real keys and token independently.
- Start both Compose projects with the shared network and overlays.
- Run the HTTP integration suite and a live one-job four-role test on the exact branch heads.
- Verify that governance checks the coder's artifact hashes and tester's actual command evidence, not merely the model's prose.

No Docker end-to-end run is claimed from the current execution sandbox.