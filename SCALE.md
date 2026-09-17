# Runner scale

One container = one concurrent GitHub job.

```bash
# first runner
PRINT_TOKEN=1 GITHUB_REPOSITORY=doitupsolutions810-crow/control12-workspace ./scripts/mint-runner-token.sh
docker compose --profile runner up --build

# second concurrent job
PRINT_TOKEN=1 ./scripts/mint-runner-token.sh   # mint a *new* token
GITHUB_RUNNER_TOKEN_2=... docker compose --profile runner -f docker-compose.yml -f docker-compose.runner-scale.yml up --build
```

Image: ghcr.io/actions/actions-runner:2.331.0 (above the 2.329 registration floor).
