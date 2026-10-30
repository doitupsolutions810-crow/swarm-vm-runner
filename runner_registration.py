#!/usr/bin/env python3
"""Runner registration module — binds swarm-vm-runner's minted token to a repo's
self-hosted runner pool. Fail-closed: no token, no ledger, no registration.
Round 21 fix: gh runner add returns 404 (not a valid gh subcommand);
registration now shells to ./config.sh --url --token, the documented sequence.
Ledger path is injectable — no hardcoded ledger/success_proofs.jsonl.
"""
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone


def verify_token_against_ledger(token: str, ledger_path: str) -> dict:
    """Verify a minted runner token against the chained SHA-256 ledger.
    Returns {ok, chain_depth, reason}. HOLD_UNMEASURED if ledger missing,
    HOLD_POISONED if chain breaks, HOLD_UNLINEAGED if token absent."""
    if not token:
        return {"ok": False, "chain_depth": 0, "reason": "HOLD_UNLINEAGED"}
    try:
        with open(ledger_path) as f:
            entries = [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError:
        return {"ok": False, "chain_depth": 0, "reason": "HOLD_UNMEASURED"}
    if not entries:
        return {"ok": False, "chain_depth": 0, "reason": "HOLD_UNMEASURED"}
    prev = None
    for i, e in enumerate(entries):
        payload = json.dumps({k: v for k, v in e.items() if k != "hash"}, sort_keys=True)
        digest = hashlib.sha256(payload.encode()).hexdigest()
        if e.get("hash") != digest:
            return {"ok": False, "chain_depth": i, "reason": "HOLD_POISONED", "broken_entry": i}
        if prev and e.get("prev_hash") != prev:
            return {"ok": False, "chain_depth": i, "reason": "HOLD_POISONED", "broken_link": i}
        prev = digest
    for e in entries:
        if e.get("token") == token or e.get("token_hash") == hashlib.sha256(token.encode()).hexdigest():
            return {"ok": True, "chain_depth": len(entries), "reason": "VERIFIED"}
    return {"ok": False, "chain_depth": len(entries), "reason": "HOLD_UNLINEAGED"}


def register_runner(token: str, repo: str, label: str,
                    ledger_path: str = "ledger/success_proofs.jsonl",
                    config_sh: str = "./ config.sh",
                    runner_dir: str = ".") -> dict:
    """Register via ./config.sh — the documented GitHub sequence.
    config_sh: path to config.sh. runner_dir: where config.sh lives.
    Returns runner ID or HOLD state."""
    v = verify_token_against_ledger(token, ledger_path)
    if not v["ok"]:
        return v
    url = f"https://github.com/{repo}"
    try:
        r = subprocess.run(
            [config_sh, "--url", url, "--token", token, "--name", label,
             "--labels", label, "--work", "_work", "--unattended"],
            capture_output=True, text=True, timeout=120, cwd=runner_dir,
        )
        if r.returncode != 0:
            return {"ok": False, "reason": "HOLD_UNREGISTERED",
                    "stderr": r.stderr.strip(), "stdout": r.stdout.strip()}
        out = (r.stdout + "\n" + r.stderr).strip()
        return {"ok": True, "reason": "REGISTERED", "output": out,
                "chain_depth": v["chain_depth"]}
    except FileNotFoundError:
        return {"ok": False, "reason": "HOLD_UNREGISTERED",
                "detail": f"config.sh not found at {config_sh}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "HOLD_UNREGISTERED", "detail": "timeout"}


def self_test():
    import tempfile, os
    e1 = {"ts": "2026-09-17T00:00:00Z", "proof": "success",
          "token_hash": hashlib.sha256(b"tok-1").hexdigest()}
    p1 = json.dumps(e1, sort_keys=True)
    e1["hash"] = hashlib.sha256(p1.encode()).hexdigest()
    e1["prev_hash"] = None
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".jsonl") as f:
        f.write(json.dumps(e1) + "\n")
        lp = f.name
    r1 = verify_token_against_ledger("tok-1", lp)
    assert r1["ok"] is True and r1["reason"] == "VERIFIED", r1
    r2 = verify_token_against_ledger("", lp)
    assert r2["reason"] == "HOLD_UNLINEAGED", r2
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".jsonl") as f:
        f.write('{"hash": "deadbeef", "proof": "x"}\n')
        lp2 = f.name
    r3 = verify_token_against_ledger("tok-1", lp2)
    assert r3["reason"] == "HOLD_POISONED", r3
    r4 = register_runner("tok-1", "o/r", "ci", ledger_path=lp,
                         config_sh="__no_such_binary__")
    assert r4["reason"] == "HOLD_UNREGISTERED", r4
    os.unlink(lp); os.unlink(lp2)
    return "VERIFIED"


if __name__ == "__main__":
    print(self_test())
