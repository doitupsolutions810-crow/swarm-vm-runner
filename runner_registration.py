#!/usr/bin/env python3
"""Runner registration module — binds swarm-vm-runner's minted token to a repo's
self-hosted runner pool. Fail-closed: no token, no ledger, no registration.
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
    # token must appear in some entry's token field
    for e in entries:
        if e.get("token") == token or e.get("token_hash") == hashlib.sha256(token.encode()).hexdigest():
            return {"ok": True, "chain_depth": len(entries), "reason": "VERIFIED"}
    return {"ok": False, "chain_depth": len(entries), "reason": "HOLD_UNLINEAGED"}


def register_runner(token: str, repo: str, label: str, gh_bin: str = "gh") -> dict:
    """Register a self-hosted runner via gh. Returns runner ID or HOLD state."""
    v = verify_token_against_ledger(token, "ledger/success_proofs.jsonl")
    if not v["ok"]:
        return v
    try:
        r = subprocess.run(
            [gh_bin, "runner", "add", "--repo", repo, "--label", label, "--token", token],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            return {"ok": False, "reason": "HOLD_UNREGISTERED", "stderr": r.stderr.strip()}
        # parse runner ID from output if present
        for line in r.stdout.splitlines():
            if "runner" in line.lower() and any(c.isdigit() for c in line):
                return {"ok": True, "reason": "REGISTERED", "output": line.strip(), "chain_depth": v["chain_depth"]}
        return {"ok": True, "reason": "REGISTERED", "output": r.stdout.strip(), "chain_depth": v["chain_depth"]}
    except FileNotFoundError:
        return {"ok": False, "reason": "HOLD_UNREGISTERED", "detail": "gh not installed"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "HOLD_UNREGISTERED", "detail": "timeout"}


def self_test():
    import tempfile, os
    # build a minimal valid ledger
    e1 = {"ts": "2026-09-17T00:00:00Z", "proof": "success", "token_hash": hashlib.sha256(b"tok-1").hexdigest()}
    p1 = json.dumps(e1, sort_keys=True)
    e1["hash"] = hashlib.sha256(p1.encode()).hexdigest()
    e1["prev_hash"] = None
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".jsonl") as f:
        f.write(json.dumps(e1) + "\n")
        lp = f.name
    # monkeypatch ledger path
    global verify_token_against_ledger
    _orig = verify_token_against_ledger
    def _v(token, ledger_path=lp):
        return _orig(token, lp)
    # case 1: valid token
    r1 = _v("tok-1")
    assert r1["ok"] is True and r1["reason"] == "VERIFIED" and r1["chain_depth"] == 1, r1
    # case 2: missing token
    r2 = _v("")
    assert r2["reason"] == "HOLD_UNLINEAGED", r2
    # case 3: corrupt ledger
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".jsonl") as f:
        f.write('{"hash": "deadbeef", "proof": "x"}\n')
        lp2 = f.name
    r3 = _orig("tok-1", lp2)
    assert r3["reason"] == "HOLD_POISONED", r3
    # case 4: gh not installed
    r4 = register_runner("tok-1", "o/r", "ci", gh_bin="__no_such_binary__")
    # verify_token passes but gh missing -> HOLD_UNREGISTERED
    assert r4["reason"] == "HOLD_UNREGISTERED", r4
    os.unlink(lp); os.unlink(lp2)
    return "VERIFIED"


if __name__ == "__main__":
    print(self_test())
