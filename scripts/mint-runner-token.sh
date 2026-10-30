#!/usr/bin/env bash
set -euo pipefail
repo="${GITHUB_REPOSITORY:-doitupsolutions810-crow/control12-workspace}"
auth="${GITHUB_TOKEN:-}"
if [[ -z "$auth" ]]; then echo "FAIL_CLOSED: set GITHUB_TOKEN" >&2; exit 2; fi
resp="$(curl -fsS -X POST -H "Accept: application/vnd.github+json" -H "Authorization: Bearer ${auth}" -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/repos/${repo}/actions/runners/registration-token")"
token="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' <<<"$resp")"
if [[ -z "$token" ]]; then echo "FAIL_CLOSED: empty registration token" &>2; exit 2; fi

# Round 21 fix: write a token-hash record to the attested ledger so
# runner_registration.py can verify this mint against the chain.
LEDGER_DIR="${ATTESTED_HISTORY_LEDGER_DIR:-ledger}"
LEDGER_FILE="${LEDGER_DIR}/success_proofs.jsonl"
mkdir -p "${LEDGER_DIR}"
python3 - <<'PY'
import hashlib, json, os, time
token = os.environ.get("TOKEN_TO_HASH", "")
parent = os.environ.get("PARENT_DIGEST", "")
kind = "runner-mint"
payload_hash = hashlib.sha256(token.encode()).hexdigest()
digest = hashlib.sha256(f"{parent}|{kind}|{payload_hash}".encode()).hexdigest()
entry = {"digest": digest, "parent": parent, "kind": kind,
         "payload_hash": payload_hash, "ts": int(time.time()),
         "repo": os.environ.get("MINT_REPO", "")}
path = os.environ["LEDGER_FILE"]
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(entry) + "\n")
print(f"ledger entry appended: line digest {digest[:12]}...")
PY
export TOKEN_TO_HASH="$token" PARENT_DIGEST="${PARENT_DIGEST:-}" MINT_REPO="$repo" LEDGER_FILE="$LEDGER_FILE"

if [[ "${PRINT_TOKEN:-0}" == "1" ]]; then printf '%s\n' "$token"; else echo "token minted for ${repo}; ledger ${LEDGER_FILE}; PRINT_TOKEN=1 to print"; fi
