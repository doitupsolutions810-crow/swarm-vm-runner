from __future__ import annotations

import pytest

from scripts.prove_success import (
    REQUIRED_ROLES, REQUIRED_SERVICES, ProofError, completed_role_chain,
    find_job, health_is_ready, missing_required_services, parse_running_services,
)


def complete(job_id="job-1"):
    return {
        "id": job_id,
        "status": "completed",
        "chain": list(REQUIRED_ROLES),
        "events": [{"role": role, "status": "passed"} for role in REQUIRED_ROLES],
    }


def test_required_compose_service_set_is_explicit():
    assert missing_required_services(set()) == sorted(REQUIRED_SERVICES)
    assert missing_required_services(set(REQUIRED_SERVICES)) == []


def test_parse_services_ignores_blank_lines_and_trims_spaces():
    assert parse_running_services("redis\n coordinator \n\nworker-debugger\n") == {
        "redis", "coordinator", "worker-debugger"
    }


def test_coordinator_health_requires_redis_too():
    assert health_is_ready({"ok": True, "redis": True})
    assert not health_is_ready({"ok": True, "redis": False})
    assert not health_is_ready({"ok": False, "redis": True})
    assert not health_is_ready({"ok": True})
    assert not health_is_ready([])


def test_exact_target_job_is_selected_not_any_completed_job():
    payload = {"jobs": [complete("job-unrelated"), {"id": "job-target", "status": "running"}]}
    assert find_job(payload, "job-target")["status"] == "running"


@pytest.mark.parametrize("payload", [None, [], {}, {"jobs": {}}, {"jobs": "bad"}])
def test_invalid_jobs_payload_is_rejected(payload):
    with pytest.raises(ProofError):
        find_job(payload, "job-1")


def test_missing_or_duplicate_target_job_is_rejected():
    with pytest.raises(ProofError):
        find_job({"jobs": [complete("other")]}, "job-1")
    with pytest.raises(ProofError):
        find_job({"jobs": [complete(), complete()]}, "job-1")


def test_exact_four_role_sequence_is_required():
    assert completed_role_chain(complete())


@pytest.mark.parametrize("mutation", [
    lambda job: job.update(status="running"),
    lambda job: job.update(chain=["debugger", "coder", "tester"]),
    lambda job: job.update(events=job["events"][:-1]),
    lambda job: job.update(events=list(reversed(job["events"]))),
    lambda job: job.update(events=job["events"][:-1] + [{"role": "governance", "status": "failed"}]),
    lambda job: job.update(events=job["events"] + [{"role": "other", "status": "passed"}]),
])
def test_incomplete_or_wrong_role_chain_never_passes(mutation):
    job = complete()
    mutation(job)
    assert not completed_role_chain(job)


def test_completed_unrelated_job_does_not_satisfy_target_acceptance():
    target = find_job(
        {"jobs": [complete("unrelated"), {"id": "job-target", "status": "running"}]},
        "job-target",
    )
    assert not completed_role_chain(target)
