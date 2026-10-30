#!/usr/bin/env bash
set -euo pipefail
repo="${GITHUB_REPOSITORY:-}"
name="${GITTER_RUNNER_NAME:-control12-swarm-1}"
labels="${GITTER_RUNNER_LABELS:-self-hosted,linux,x64,control12,swarm}"
token="${GITTER_RUNNER_TOKEN:-}"
if [[ -z "$repo" ]]; then echo "FAIL_CLOSED: GITHTER_REPOSITORY is required" >&2; exit 2; fi
if [[ -z "$token" ]]; then echo "FAIL_CLOSED: GITHTER_RUNNER_TOKEN is required" >&2; exit 2; fi
url="https://github.com/${repo}"
cd /home/runner
./config.sh --unattended --replace --ephemeral --url "$url" --token "$token" --name "$name" --labels "$labels"
# Registration tokens are single-use. Remove them from the runner process environment.
unset token GITHTER_RUNNER_TOKEN
exec ./run.sh
