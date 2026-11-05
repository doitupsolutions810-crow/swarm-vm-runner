from __future__ import annotations

"""Strict, bounded acceptance checks for the Swarm VM coordinator."""

REQUIRED_SERVICES = frozenset({
    "redis", "coordinator", "worker-debugger", "worker-coder",
    "worker-tester", "worker-governance",
})
REQUIRED_ROLES = ("debugger", "coder", "tester", "governance")


class ProofError(ValueError):
    pass


def parse_running_services(output: str) -> set[str]:
    return {line.strip() for line in output.splitlines() if line.strip()}


def missing_required_services(running: set[str]) -> list[str]:
    return sorted(REQUIRED_SERVICES - running)


def health_is_ready(payload) -> bool:
    return isinstance(payload, dict) and payload.get("ok") is True and payload.get("redis") is True


def find_job(payload, job_id: str) -> dict:
    if not isinstance(payload, dict) or not isinstance(payload.get("jobs"), list):
        raise ProofError("jobs response must contain a jobs array")
    matches = [item for item in payload["jobs"] if isinstance(item, dict) and item.get("id") == job_id]
    if len(matches) != 1:
        raise ProofError(f"expected exactly one matching job; found {len(matches)}")
    return matches[0]


def completed_role_chain(job) -> bool:
    if not isinstance(job, dict) or job.get("status") != "completed":
        return False
    if job.get("chain") != list(REQUIRED_ROLES):
        return False
    events = job.get("events")
    if not isinstance(events, list) or len(events) != len(REQUIRED_ROLES):
        return False
    observed = []
    for event in events:
        if not isinstance(event, dict):
            return False
        observed.append((event.get("role"), event.get("status")))
    return observed == [(role, "passed") for role in REQUIRED_ROLES]
