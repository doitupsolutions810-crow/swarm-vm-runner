#!/usr/bin/env bash
set -euo pipefail
repo="${GITHUB_REPOSITORY:-doitupsolutions810-crow/control12-workspace}"
auth="${GITHUB_TOKEN:-}"
if [[ -z "$auth" ]]; then echo "FAIL_CLOSED: set GITHUB_TOKEN" >&2; exit 2; fi
resp="$(curl -fsS -X POST -H "Accept: application/vnd.github+json" -H "Authorization: Bearer ${auth}" -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/repos/${repo}/actions/runners/registration-token")"
token="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' <<<"$resp")"
if [[ -z "$token" ]]; then echo "FAIL_CLOSED: empty registration token" >&2; exit 2; fi
if [[ "${PRINT_TOKEN:-0}" == "1" ]]; then printf '%s\n' "$token"; else echo "token minted for ${repo}; PRINT_TOKEN=1 to print"; fi
