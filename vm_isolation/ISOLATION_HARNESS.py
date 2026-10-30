#!/usr/bin/env python3
import subprocess, sys, json, hashlib, time

RESTRICTED_SRC = """
import hashlib, json

def admit(path):
    s = path.get("S", 1.0)
    orient = path.get("orientation", "clean")
    flags = set(path.get("flags", []))
    prov = path.get("provenance", {})
    if prov.get("poisoned"):
        return "HOLD_POISONED"
    if "expired" in flags:
        return "REJECT_EXPIRED"
    if "bad_sig" in flags:
        return "REJECT_BAD_SIG"
    if "uncapable" in flags:
        return "HOLD_UNCAPABLE"
    if "unlineaged" in flags:
        return "HOLD_UNLINEAGED"
    if "unmeasured" in flags:
        return "HOLD_UNMEASURED"
    if "hot" in flags or s > 0.05:
        return "HOLD_HOT"
    if "mixed" in flags or orient == "mixed":
        return "HOLD_MIXED"
    if "flaky" in flags:
        return "HOLD_FLAKY"
    if s <= 0.02 and orient == "clean":
        return "READY_CONE"
    return "READY"

PATHS = [
    {"name":"clean","S":0.01,"orientation":"clean","flags":[]},
    {"name":"uncapable","S":0.01,"orientation":"clean","flags":["uncapable "]},
    {"name":"unlineaged","S":0.01,"orientation":"clean","flags":["unlineaged "]},
    {"name":"unmeasured","S":0.01,"orientation":"clean","flags":["unmeasured "]},
    {"name":"hot","S":0.08,"orientation":"clean","flags":["hot "]},
    {"name":"mixed","S":0.01,"orientation":"mixed","flags":["mixed "]},
    {"name":"poisoned","S":0.01,"orientation":"clean","flags":[],"provenance":{"poisoned":True}},
    {"name":"expired","S":0.01,"orientation":"clean","flags":["expired "]},
    {"name":"bad_sig","S":0.01,"orientation":"clean","flags":["bad_sig "]},
]
results = {p["name"]: admit(p) for p in PATHS}
spine_ok = all(hashlib.sha256(str(i).encode()).hexdigest() for i in range(8))
out = {"results": results, "spine_ok": spine_ok,
       "digest": hashlib.sha256(json.dumps(results, sort_keys=True).encode()).hexdigest()}
print(json.dumps(out))
"""

def run_restricted():
    r = subprocess.run([sys.executable, "-I", "-c", RESTRICTED_SRC],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return {"error": "nonzero", "stderr": r.stderr[:500]}
    return json.loads(r.stdout)

def expected():
    return {
        "clean": "READY_CONE", "uncapable": "HOLD_UNCAPABLE",
        "unlineaged": "HOLD_UNLINEAGED", "unmeasured": "HOLD_UNMEASURED",
        "hot": "HOLD_HOT", "mixed": "HOLD_MIXED", "poisoned": "HOLD_POISONED",
        "expired": "REJECT_EXPIRED", "bad_sig": "REJECT_BAD_SIG",
    }

def main():
    t0 = time.time()
    got = run_restricted()
    exp = expected()
    if "error" in got:
        verdict = "FAIL_ISOLATION"
        detail = got
    else:
        mismatches = {k: (got["results"][k], exp[k]) for k in exp
                      if got["results"].get(k) != exp[k]}
        verdict = "PASS" if not mismatches and got.get("spine_ok") else "FAIL_MISMATCH"
        detail = {"mismatches": mismatches, "spine_ok": got.get("spine_ok"),
                  "digest": got.get("digest")}
    artifact = {"verdict": verdict, "detail": detail,
                "elapsed_s": round(time.time() - t0, 4),
                "ts": time.time()}
    path = "ISOLATION_HARNESS_OUT.json"
    with open(path, "w") as f:
        json.dump(artifact, f, indent=2)
    ledger = "LEDGER.jsonl"
    entry = {"kind": "isolation-harness", "verdict": verdict,
             "digest": hashlib.sha256(json.dumps(artifact, sort_keys=True).encode()).hexdigest(),
             "ts": time.time()}
    with open(ledger, "a") as f:
        f.write(json.dumps(entry) + "\n")
    print(json.dumps(artifact, indent=2))

if __name__ == "__main__":
    main()
