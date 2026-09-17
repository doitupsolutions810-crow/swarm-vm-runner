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
