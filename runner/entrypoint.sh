#!/usr/bin/env bash
set -euo pipefail
repo="${GITHUB_REPOSITORY:-}"
name="${GITHUB_RUNNER_NAME:-control12-swarm-1}"
labels="${GITHUB_RUNNER_LABELS:-self-hosted,linux,x64,control12,swarm}"
token="${GITHUB_RUNNER_TOKEN:-}"
if [[ -z "$repo" ]]; then echo "FAIL_CLOSED: GITHUB_REPOSITORY is required" >&2; exit 2; fi
if [[ -z "$token" ]]; then echo "FAIL_CLOSED: GITHUB_RUNNER_TOKEN is required" >&2; exit 2; fi
url="https://github.com/${repo}"
cd /home/runner
./config.sh --unattended --replace --ephemeral --url "$url" --token "$token" --name "$name" --labels "$labels"
exec ./run.sh
