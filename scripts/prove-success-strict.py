#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from prove_success import (
    ProofError,
    completed_role_chain,
    find_job,
    health_is_ready,
    missing_required_services,
    parse_running_services,
    parse_wait_seconds,
    validate_job_id,
)

REQUEST_TIMEOUT = 5
COMPOSE_TIMEOUT_SECONDS = 10
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class _NoRedirectHandler(HTTPRedirectHandler):
    """A coordinator redirect is not an accepted health or job response."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NO_REDIRECT_OPENER = build_opener(_NoRedirectHandler)


def _unique_json_object(pairs):
    """Reject duplicate member names instead of silently accepting the last value."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object member: {key!r}")
        result[key] = value
    return result


def _reject_json_constant(value: str):
    """Reject JavaScript NaN/Infinity tokens, which are not valid JSON values."""
    raise ValueError(f"non-standard JSON constant: {value}")


def request_json(base: str, path: str, method: str = "GET", payload=None):
    """Make a bounded JSON request and normalize malformed/transport errors."""
    try:
        parsed = urlsplit(base)
        host = parsed.hostname
        # Accessing .port validates malformed port syntax.
        _ = parsed.port
    except (TypeError, ValueError) as exc:
        raise ProofError(f"invalid coordinator URL: {exc}") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ProofError(
            "COORDINATOR_URL must be an absolute HTTP(S) URL without credentials, query, or fragment"
        )
    if not isinstance(path, str):
        raise ProofError("coordinator path must be an absolute local API path")
    parsed_path = urlsplit(path)
    try:
        decoded_path = unquote(parsed_path.path, errors="strict")
    except (UnicodeError, ValueError) as exc:
        raise ProofError("coordinator path contains invalid escaping") from exc
    if (
        not parsed_path.path.startswith("/")
        or parsed_path.path.startswith("//")
        or parsed_path.scheme
        or parsed_path.netloc
        or parsed_path.query
        or parsed_path.fragment
        or "://" in path
        or "\\" in decoded_path
        or "\x00" in decoded_path
        or any(segment in {".", ".."} for segment in decoded_path.split("/"))
    ):
        raise ProofError("coordinator path must be an absolute local API path without traversal")

    try:
        data = json.dumps(payload, allow_nan=False).encode("utf-8") if payload is not None else None
        req = Request(
            base.rstrip("/") + path,
            data=data,
            method=method,
            headers={"content-type": "application/json"},
        )
        with _NO_REDIRECT_OPENER.open(req, timeout=REQUEST_TIMEOUT) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ProofError(f"{path} response exceeded {MAX_RESPONSE_BYTES} bytes")
            return response.status, json.loads(
                raw.decode("utf-8"),
                object_pairs_hook=_unique_json_object,
                parse_constant=_reject_json_constant,
            )
    except HTTPError as exc:
        try:
            detail = exc.read(2048).decode("utf-8", "replace")
        finally:
            exc.close()
        raise ProofError(f"{path} returned HTTP {exc.code}: {detail}") from None
    except (URLError, TimeoutError, OSError, ValueError, UnicodeError, HTTPException, RecursionError) as exc:
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
        content = entrypoint.read_text(encoding="utf-8", errors="replace")
        required_guards = ("FAIL_CLOSED", "GITHUB_REPOSITORY", "GITHUB_RUNNER_TOKEN")
        if all(part in content for part in required_guards):
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
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=COMPOSE_TIMEOUT_SECONDS,
                check=False,
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
        base = os.environ.get("COORDINATOR_URL", "http://127.0.0.1:4100")
        try:
            wait_seconds = parse_wait_seconds(os.environ.get("PROVE_SUCCESS_WAIT_SECONDS"))
            status, health = request_json(base, "/health")
            if status != 200 or not health_is_ready(health):
                raise ProofError(f"coordinator or Redis health is not ready: {health!r}")
            passed.append("coordinator and Redis health verified")

            status, created = request_json(
                base,
                "/api/jobs",
                method="POST",
                payload={"objective": "prove-success:" + uuid.uuid4().hex},
            )
            if status != 202 or not isinstance(created, dict):
                raise ProofError(f"job was not accepted with HTTP 202 and an id: {created!r}")
            job_id = validate_job_id(created.get("id"))
            passed.append("unique verification job accepted: " + job_id)

            deadline = time.monotonic() + wait_seconds
            while True:
                poll_status, snapshot = request_json(base, "/api/jobs")
                if poll_status != 200:
                    raise ProofError(f"/api/jobs poll returned HTTP {poll_status}, expected 200")
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
                    raise ProofError(
                        f"target job did not complete within {wait_seconds}s; last state={state}"
                    )
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
