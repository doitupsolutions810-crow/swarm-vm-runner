from __future__ import annotations

import importlib.util
import sys
import threading
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path

import pytest

from scripts.prove_success import ProofError, parse_wait_seconds, validate_job_id

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
_spec = importlib.util.spec_from_file_location("strict_proof_under_test", SCRIPT_DIR / "prove-success-strict.py")
assert _spec is not None and _spec.loader is not None
strict_proof = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = strict_proof
_spec.loader.exec_module(strict_proof)
StrictProofError = strict_proof.ProofError


@pytest.mark.parametrize(("raw", "expected"), [(None, 120), ("", 120), ("1", 1), ("600", 600)])
def test_wait_parser_accepts_default_and_boundaries(raw, expected):
    assert parse_wait_seconds(raw) == expected


@pytest.mark.parametrize("raw", ["0", "601", "-1", "+1", "1.5", "abc", "１２", " 1", "1 ", "9" * 4096])
def test_wait_parser_rejects_unbounded_or_noncanonical_values(raw):
    with pytest.raises(ProofError):
        parse_wait_seconds(raw)


@pytest.mark.parametrize("job_id", ["job-1", "queue_42", "a" * 128])
def test_job_id_accepts_canonical_values(job_id):
    assert validate_job_id(job_id) == job_id


@pytest.mark.parametrize("job_id", [
    None, 1, "", " ", " job-1", "job-1 ", "x" * 129,
    "job\n1", "job\u202e1", "job\u200b1",
])
def test_job_id_rejects_empty_unbounded_or_spoofed_values(job_id):
    with pytest.raises(ProofError):
        validate_job_id(job_id)


@pytest.mark.parametrize("url", [
    "", "relative/path", "file:///etc/passwd", "ftp://localhost/x",
    "http://user:secret@localhost", "http://localhost?token=x",
    "http://localhost/#fragment", "http://localhost:bad", "http://[bad",
])
def test_request_rejects_unsafe_or_malformed_coordinator_urls(url):
    with pytest.raises(StrictProofError):
        strict_proof.request_json(url, "/health")


@pytest.mark.parametrize("path", [
    "health", "https://elsewhere.invalid/x", "//elsewhere.invalid/x",
    "/api/../health", "/api/%2e%2e/health", "/api/%2F..%2Fhealth",
    "/health?token=x", "/health#fragment",
])
def test_request_rejects_nonlocal_api_paths(path):
    with pytest.raises(StrictProofError):
        strict_proof.request_json("http://127.0.0.1:1", path)


@pytest.fixture
def response_server():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path == "/json":
                body, status = b'{"ok":true}', 200
            elif self.path == "/empty":
                body, status = b"", 200
            elif self.path == "/invalid-json":
                body, status = b'{not-json', 200
            elif self.path == "/invalid-utf8":
                body, status = b'\xff\xfe', 200
            elif self.path == "/too-large":
                body, status = b"x" * (2 * 1024 * 1024 + 1), 200
            elif self.path == "/unavailable":
                body, status = b'{"error":"offline"}', 503
            elif self.path == "/redirect":
                self.send_response(302)
                self.send_header("location", "/json")
                self.end_headers()
                return
            elif self.path == "/deep-json":
                body, status = b"[" * 12000 + b"0" + b"]" * 12000, 200
            elif self.path == "/duplicate-key":
                body, status = b'{"ok":true,"ok":false,"redis":true}', 200
            elif self.path == "/nonfinite":
                body, status = b'{"ok":true,"redis":true,"measurement":NaN}', 200
            else:
                body, status = b'{"error":"not found"}', 404
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()



def test_request_timeout_is_bounded(monkeypatch):
    class SlowHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            time.sleep(0.25)
            try:
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            except OSError:
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(strict_proof, "REQUEST_TIMEOUT", 0.02)
    started = time.monotonic()
    try:
        with pytest.raises(StrictProofError):
            strict_proof.request_json(f"http://127.0.0.1:{server.server_port}", "/slow")
        assert time.monotonic() - started < 1.0
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_compose_timeout_fails_closed_before_network(tmp_path, monkeypatch, capsys):
    root = tmp_path / "project"
    scripts = root / "scripts"
    runner = root / "runner"
    scripts.mkdir(parents=True)
    runner.mkdir()
    (root / "docker-compose.yml").write_text("services: {}\n")
    (runner / "entrypoint.sh").write_text("FAIL_CLOSED GITHUB_REPOSITORY GITHUB_RUNNER_TOKEN\n")
    monkeypatch.setattr(strict_proof, "__file__", str(scripts / "prove-success-strict.py"))
    monkeypatch.setattr(strict_proof, "COMPOSE_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(strict_proof.shutil, "which", lambda _name: "/usr/bin/docker")

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(strict_proof.subprocess, "run", timeout)
    monkeypatch.setattr(strict_proof, "request_json", lambda *_args, **_kwargs: pytest.fail("network contacted"))
    monkeypatch.setenv("COORDINATOR_URL", "http://127.0.0.1:1")
    assert strict_proof.main() == 1
    output = capsys.readouterr().out
    assert "docker compose ps could not complete" in output
    assert "SYSTEM NOT VERIFIED" in output
    assert "SYSTEM SUCCESS" not in output

def test_request_returns_decoded_json_for_success(response_server):
    assert strict_proof.request_json(response_server, "/json") == (200, {"ok": True})


@pytest.mark.parametrize("path", [
    "/invalid-json", "/invalid-utf8", "/empty", "/too-large", "/unavailable",
    "/redirect", "/deep-json", "/duplicate-key", "/nonfinite"
])
def test_request_normalizes_malformed_oversized_http_and_redirect_responses(response_server, path):
    with pytest.raises(StrictProofError):
        strict_proof.request_json(response_server, path)
