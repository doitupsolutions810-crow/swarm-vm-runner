from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROLES = ["debugger", "coder", "tester", "governance"]
SERVICES = ["redis", "coordinator", "worker-debugger", "worker-coder", "worker-tester", "worker-governance"]


class State:
    target_status = "completed"
    target_events = [{"role": role, "status": "passed"} for role in ROLES]
    jobs = []


def start_server(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, payload):
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/health":
                return self.reply(200, {"ok": True, "redis": True})
            if self.path == "/api/jobs":
                return self.reply(200, {"jobs": state.jobs})
            return self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/api/jobs":
                return self.reply(404, {"error": "not found"})
            length = int(self.headers.get("content-length", "0"))
            json.loads(self.rfile.read(length) or b"{}")
            target = {
                "id": "job-target",
                "status": state.target_status,
                "chain": ROLES,
                "events": state.target_events,
            }
            unrelated = {
                "id": "job-unrelated",
                "status": "completed",
                "chain": ROLES,
                "events": [{"role": role, "status": "passed"} for role in ROLES],
            }
            state.jobs = [unrelated, target]
            return self.reply(202, {"id": "job-target", "status": "queued"})

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def make_project(tmp_path):
    source_root = Path(__file__).resolve().parents[1]
    scripts = tmp_path / "scripts"
    runner = tmp_path / "runner"
    scripts.mkdir()
    runner.mkdir()
    shutil.copy(source_root / "scripts" / "prove_success.py", scripts / "prove_success.py")
    shutil.copy(source_root / "scripts" / "prove-success-strict.py", scripts / "prove-success-strict.py")
    (tmp_path / "docker-compose.yml").write_text("name: test\nservices: {}\n")
    (runner / "entrypoint.sh").write_text(
        "#!/bin/sh\necho FAIL_CLOSED GITHUB_REPOSITORY GITHUB_RUNNER_TOKEN\n"
    )
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    docker = fake_bin / "docker"
    docker.write_text("#!/bin/sh\nprintf '%s\n' " + " ".join(SERVICES) + "\n")
    docker.chmod(0o755)
    return fake_bin


def run_proof(tmp_path, fake_bin, server, wait_seconds="5"):
    env = os.environ.copy()
    env["COORDINATOR_URL"] = f"http://127.0.0.1:{server.server_port}"
    env["PROVE_SUCCESS_WAIT_SECONDS"] = wait_seconds
    env["PATH"] = str(fake_bin) + os.pathsep + env.get("PATH", "")
    return subprocess.run(
        [sys.executable, str(tmp_path / "scripts" / "prove-success-strict.py")],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


def test_strict_proof_accepts_exact_four_role_target_job(tmp_path):
    state = State()
    fake_bin = make_project(tmp_path)
    server, thread = start_server(state)
    try:
        result = run_proof(tmp_path, fake_bin, server)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "job-target" in result.stdout
        assert "target job completed debugger -> coder -> tester -> governance" in result.stdout
        assert "SYSTEM SUCCESS" in result.stdout
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_unrelated_completed_job_cannot_make_running_target_pass(tmp_path):
    state = State()
    state.target_status = "running"
    fake_bin = make_project(tmp_path)
    server, thread = start_server(state)
    try:
        result = run_proof(tmp_path, fake_bin, server, wait_seconds="1")
        assert result.returncode == 1
        assert "target job did not complete" in result.stdout
        assert "SYSTEM NOT VERIFIED" in result.stdout
        assert "SYSTEM SUCCESS" not in result.stdout
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_completed_target_with_wrong_role_order_is_rejected(tmp_path):
    state = State()
    state.target_events = [{"role": role, "status": "passed"} for role in reversed(ROLES)]
    fake_bin = make_project(tmp_path)
    server, thread = start_server(state)
    try:
        result = run_proof(tmp_path, fake_bin, server)
        assert result.returncode == 1
        assert "without all four roles passing in order" in result.stdout
        assert "SYSTEM NOT VERIFIED" in result.stdout
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_missing_required_role_worker_fails_before_coordinator_health_check(tmp_path):
    state = State()
    fake_bin = make_project(tmp_path)
    docker = fake_bin / "docker"
    docker.write_text(
        "#!/bin/sh\nprintf '%s\\n' redis coordinator worker-debugger worker-coder worker-tester\n"
    )
    docker.chmod(0o755)
    server, thread = start_server(state)
    try:
        result = run_proof(tmp_path, fake_bin, server)
        assert result.returncode == 1
        assert "worker-governance" in result.stdout
        assert "coordinator and Redis health verified" not in result.stdout
        assert "SYSTEM NOT VERIFIED" in result.stdout
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_docker_compose_nonzero_exit_fails_closed_before_network_calls(tmp_path):
    state = State()
    fake_bin = make_project(tmp_path)
    docker = fake_bin / "docker"
    docker.write_text("#!/bin/sh\necho compose unavailable >&2\nexit 17\n")
    docker.chmod(0o755)
    server, thread = start_server(state)
    try:
        result = run_proof(tmp_path, fake_bin, server)
        assert result.returncode == 1
        assert "docker compose ps failed" in result.stdout
        assert "coordinator and Redis health verified" not in result.stdout
        assert "SYSTEM SUCCESS" not in result.stdout
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_missing_docker_cli_fails_closed_before_coordinator_network(tmp_path):
    state = State()
    fake_bin = make_project(tmp_path)
    (fake_bin / "docker").unlink()
    server, thread = start_server(state)
    env = os.environ.copy()
    env["COORDINATOR_URL"] = f"http://127.0.0.1:{server.server_port}"
    env["PROVE_SUCCESS_WAIT_SECONDS"] = "5"
    # Hide the host's Docker binary as well as the fixture binary.
    env["PATH"] = str(fake_bin)
    try:
        result = subprocess.run(
            [sys.executable, str(tmp_path / "scripts" / "prove-success-strict.py")],
            cwd=tmp_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        assert result.returncode == 1
        assert "Docker CLI unavailable" in result.stdout
        assert "coordinator and Redis health verified" not in result.stdout
        assert state.jobs == []
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
