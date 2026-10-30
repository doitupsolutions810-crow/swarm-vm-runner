#!/usr/bin/env python3
import json, hashlib, time, os, sys

base = "/home/workdir/emergent_system/vm_isolation"
art_path = f"{base}/ISOLATION_HARNESS_OUT.json"
last_path = f"{base}/last_green.json"

def load(p):
    if os.path.exists(p):
        with open(p) as f: return json.load(f)
    return None

prev = load(last_path)
cur = load(art_path)
if cur is None:
    print(json.dumps({"gate":"HOLD","reason":"no isolation artifact"}))
    sys.exit(0)

ok = cur.get("verdict") == "PASS"
digest = hashlib.sha256(json.dumps(cur, sort_keys=True).encode()).hexdigest()
gate = "FIRE" if ok else "HOLD"
out = {"gate": gate, "verdict": cur.get("verdict"), "digest": digest,
       "prev_digest": (prev or {}).get("digest"),
       "changed": digest != (prev or {}).get("digest", ""),
       "ts": time.time()}
with open(last_path, "w") as f: json.dump(out, f, indent=2)
push = {"source":"daemon-cycle8","gate":gate,"digest":digest,"ts":time.time(),
        "note":"isolation harness " + ("passed" if ok else "failed") +
               "; runner still unallocated on GitHub side"}
with open(f"{base}/push_artifact_cycle8.json","w") as f: json.dump(push,f,indent=2)
print(json.dumps(out, indent=2))
