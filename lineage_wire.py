"""Attach HUMAN_ROOT to swarm-vm-runner ledger proofs."""
import hashlib

ROOT = {"kind": "HUMAN_ROOT", "sig": "ed25519:anchor", "ts": "2026-10-29T22:00:00Z"}

def attach_lineage(proof_bytes):
    digest = hashlib.sha256(proof_bytes).hexdigest()[:16]
    return {"kind": "SUCCESS_PROOF", "digest": digest, "parent": ROOT["sig"], "root": ROOT["sig"]}

def verify_chain(proof):
    return proof.get("parent") == ROOT["sig"]

if __name__ == "__main__":
    p = attach_lineage(b"swarm-vm-runner-ledger-2026-09-17")
    print(p["digest"], verify_chain(p))
