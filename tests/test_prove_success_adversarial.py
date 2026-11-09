from __future__ import annotations

import importlib.util
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from scripts.prove_success import (
    ProofError,
    REQUIRED_ROLES,
    REQUIRED_SERVICES,
    completed_role_chain,
    find_job,
    health_is_ready,
    missing_required_services,
    parse_running_services,
)

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
_spec = importlib.util.spec_from_file_location(
    "strict_proof_adversarial_under_test", SCRIPT_DIR / "prove-success-strict.py"
)
assert _spec is not None and _spec.loader is not None
strict_proof = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = strict_proof
_spec.loader.exec_module(strict_proof)


def valid_job():
    return {
        "id": "target-job",
        "status": "completed",
        "chain": list(REQUIRED_ROLES),
        "events": [{"role": role, "status": "passed"} for role in REQUIRED_ROLES],
    }


@pytest.mark.parametrize("payload", [
    None,
    [],
    {},
    {"jobs": None},
    {"jobs": "not-an-array"},
    {"jobs": [None]},
])
def test_find_job_rejects_malformed_job_collections(payload):
    with pytest.raises(ProofError):
        find_job(payload, "target-job")


def test_find_job_requires_exactly_one_matching_job_id():
    job = valid_job()
    assert find_job({"jobs": [job]}, "target-job") is job
    with pytest.raises(ProofError):
        find_job({"jobs": []}, "target-job")
    with pytest.raises(ProofError):
        find_job({"jobs": [job, dict(job)]}, "target-job")
    conflicting = dict(job)
    conflicting["status"] = "failed"
    with pytest.raises(ProofError):
        find_job({"jobs": [job, conflicting]}, "target-job")


@pytest.mark.parametrize("mutation", [
    lambda job: job.update(status="running"),
    lambda job: job.update(chain=list(reversed(REQUIRED_ROLES))),
    lambda job: job.update(chain=list(REQUIRED_ROLES) + ["extra"]),
    lambda job: job.update(events=[]),
    lambda job: job.update(events=job["events"][:-1]),
    lambda job: job.update(events=job["events"] + [job["events"][-1]]),
    lambda job: job["events"][0].update(status="failed"),
    lambda job: job["events"][1].update(role="debugger"),
    lambda job: job["events"][2].update(status="queued"),
    lambda job: job.update(events=job["events"] + [{"role": "auditor", "status": "passed"}]),
    lambda job: job.update(events=[None] + job["events"][1:]),
])
def test_completed_role_chain_rejects_partial_duplicate_or_forged_chains(mutation):
    job = valid_job()
    mutation(job)
    assert completed_role_chain(job) is False


def test_completed_role_chain_requires_literal_completed_status_and_exact_order():
    assert completed_role_chain(valid_job()) is True
    for status in (None, True, "success", "COMPLETED", "failed"):
        job = valid_job()
        job["status"] = status
        assert completed_role_chain(job) is False


@pytest.mark.parametrize("health", [
    None,
    [],
    {"ok": 1, "redis": True},
    {"ok": True, "redis": 1},
    {"ok": True, "redis": False},
    {"ok": False, "redis": True},
    {"ok": True},
])
def test_health_gate_requires_literal_coordinator_and_redis_booleans(health):
    assert health_is_ready(health) is False



@pytest.mark.parametrize("missing_service", sorted(REQUIRED_SERVICES))
def test_each_required_service_is_individually_mandatory(missing_service):
    running = set(REQUIRED_SERVICES) - {missing_service}
    assert missing_required_services(running) == [missing_service]

def test_service_gate_requires_every_named_worker_and_rejects_no_implicit_aliases():
    assert missing_required_services(set()) == sorted(REQUIRED_SERVICES)
    assert missing_required_services(set(REQUIRED_SERVICES)) == []
    missing = set(REQUIRED_SERVICES) - {"worker-governance"}
    assert missing_required_services(missing) == ["worker-governance"]
    # Similar names and a generic worker must not substitute for the required role.
    aliases = set(REQUIRED_SERVICES) - {"worker-governance"}
    aliases.update({"governance", "worker", "worker-governance-old", "worker-auditor", "metrics"})
    assert missing_required_services(aliases) == ["worker-governance"]
    assert missing_required_services(set(REQUIRED_SERVICES) | {"worker-auditor", "metrics"}) == []


def test_running_service_parser_trims_lines_and_deduplicates():
    assert parse_running_services(
        " redis \ncoordinator\nworker-debugger\n redis \n\n"
    ) == {"redis", "coordinator", "worker-debugger"}


def test_request_json_refuses_cross_origin_redirect_without_contacting_target():
    contacted = []

    class TargetHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            contacted.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

    target = HTTPServer(("127.0.0.1", 0), TargetHandler)
    target_thread = threading.Thread(target=target.serve_forever, daemon=True)
    target_thread.start()

    class RedirectHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.send_response(302)
            self.send_header(
                "Location", f"http://127.0.0.1:{target.server_port}/secret"
            )
            self.end_headers()

    origin = HTTPServer(("127.0.0.1", 0), RedirectHandler)
    origin_thread = threading.Thread(target=origin.serve_forever, daemon=True)
    origin_thread.start()
    try:
        with pytest.raises(strict_proof.ProofError):
            strict_proof.request_json(
                f"http://127.0.0.1:{origin.server_port}", "/redirect"
            )
        assert contacted == []
    finally:
        origin.shutdown()
        origin_thread.join(timeout=2)
        origin.server_close()
        target.shutdown()
        target_thread.join(timeout=2)
        target.server_close()


@pytest.mark.parametrize("base,path", [
    ("http://user:secret@127.0.0.1:4100", "/health"),
    ("http://127.0.0.1:4100?token=secret", "/health"),
    ("http://127.0.0.1:4100/#fragment", "/health"),
    ("file:///etc/passwd", "/health"),
    ("http://127.0.0.1:4100", "//evil.example/path"),
    ("http://127.0.0.1:4100", "https://evil.example/path"),
])
def test_request_json_rejects_credentialed_or_nonlocal_request_shapes(base, path):
    with pytest.raises(strict_proof.ProofError):
        strict_proof.request_json(base, path)
