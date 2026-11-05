#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from prove_success import (
    REQUIRED_SERVICES, ProofError, completed_role_chain, find_job,
    health_is_ready, missing_required_services, parse_running_services,
)

REQUEST_TIMEOUT = 5


def request_json(base: str, path: str, method: str = "GET", payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(base.rstrip("/") + path, data=data, method=method,
                  headers={"content-type": "application/json"})
    try:
        with urlopen(req, timeout=REQUEST_TIMEOUT) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise ProofError(f"{path} response exceeded 2 MiB")
            return response.status, json.loads(raw.decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read(2048).decode("utf-8", "replace")
        raise ProofError(f"{path} returned HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise ProofError(f"{path} unavailable or invalid: {exc}") from exc


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    passed, failed = [], []

    compose = root / "docker-compose.yml"
    entrypoint = root / "runner" / "entrypoint.sh"
    if compose.is_file():
        passed.append("Compose definition exists")
    else:
        failed.append("Compose definition missing")

    if entrypoint.is_file():
        text = entrypoint.read_text(encoding="utf-8", errors="replace")
        if all(part in text for part in ("FAIL_CLOSED", "GITHUB_REPOSITORY", "GITHUB_RUNNER_TOKEN")):
            passed.append("runner entrypoint contains fail-closed guards")
        else:
            failed.append("runner entrypoint is missing a fail-closed guard")
    else:
        failed.append("runner entrypoint missing")

    docker = shutil.which("docker")
    if not docker:
        failed.append("Docker CLI unavailable; required Compose topology not verified")
    else:
        try:
            ps = subprocess.run(
                [docker, "compose", "ps", "--status", "running", "--services"],
                cwd=str(root), capture_output=True, text=True, timeout=10, check=False,
            )
            if ps.returncode != 0:
                failed.append(f"docker compose ps failed: {(ps.stderr or '').strip()}")
            else:
                missing = missing_required_services(parse_running_services(ps.stdout or ""))
                if missing:
                    failed.append("required services not running: " + ", ".join(missing))
                else:
                    passed.append("all required Compose services are running")
        except (OSError, subprocess.TimeoutExpired) as exc:
            failed.append(f"docker compose ps could not complete: {exc}")

    if not failed:
        base = __import__("os").environ.get("COORDINATOR_URL", "http://127.0.0.1:4100")
        try:
            status, health = request_json(base, "/health")
            if status != 200 or not health_is_ready(health):
                raise ProofError(f"coordinator or Redis health is not ready: {health!r}")
            passed.append("coordinator and Redis health verified")

            status, created = request_json(
                base, "/api/jobs", method="POST",
                payload={"objective": "prove-success:" + uuid.uuid4().hex},
            )
            if status != 202 or not isinstance(created, dict) or not isinstance(created.get("id"), str):
                raise ProofError(f"job was not accepted with HTTP 202 and an id: {created!r}")
            job_id = created["id"]
            passed.append("unique verification job accepted: " + job_id)

            wait_seconds = 120
            deadline = time.monotonic() + wait_seconds
            while True:
                _, snapshot = request_json(base, "/api/jobs")
                job = find_job(snapshot, job_id)
                state = job.get("status")
                if state == "failed":
                    raise ProofError(f"verification job {job_id} failed")
                if state == "completed":
                    if not completed_role_chain(job):
                        raise ProofError("target job completed without all four roles passing in order")
                    passed.append("target job completed debugger -> coder -> tester -> governance")
                    break
                if state not in ("queued", "running"):
                    raise ProofError(f"target job entered unexpected state: {state!r}")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProofError(f"target job did not complete within {wait_seconds}s; last state={state}")
                time.sleep(min(2.0, remaining))
        except ProofError as exc:
            failed.append(str(exc))

    print("==========================================")
    print(" SWARM VM — STRICT SYSTEM ACCEPTANCE")
    print("==========================================")
    for item in passed:
        print("  PASS: " + item)
    for item in failed:
        print("  FAIL: " + item)
    print("------------------------------------------")
    print(f" RESULT: {len(passed)} passed, {len(failed)} failed")
    if failed:
        print(" SYSTEM NOT VERIFIED")
        return 1
    print(" SYSTEM SUCCESS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
