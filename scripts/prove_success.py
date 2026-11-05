"""Strict, bounded acceptance checks for the Swarm VM coordinator."""
from __future__ import annotations

import unicodedata

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


DEFAULT_WAIT_SECONDS = 120
MAX_WAIT_SECONDS = 600
MAX_JOB_ID_LENGTH = 128


def parse_wait_seconds(raw: str | None) -> int:
    """Parse an explicit, bounded proof wait; the default remains 120 seconds."""
    if raw is None or raw == "":
        return DEFAULT_WAIT_SECONDS
    if (
        not isinstance(raw, str)
        or len(raw) > 3
        or not raw.isascii()
        or not raw.isdecimal()
    ):
        raise ProofError("PROVE_SUCCESS_WAIT_SECONDS must be an integer from 1 to 600")
    value = int(raw)
    if not 1 <= value <= MAX_WAIT_SECONDS:
        raise ProofError("PROVE_SUCCESS_WAIT_SECONDS must be an integer from 1 to 600")
    return value


def validate_job_id(value) -> str:
    """Require a non-empty, canonical job identifier before polling."""
    if not isinstance(value, str) or not value or len(value) > MAX_JOB_ID_LENGTH:
        raise ProofError("coordinator returned an invalid job id")
    if value != value.strip() or any(
        ch.isspace() or unicodedata.category(ch) in {"Cc", "Cf", "Cs"}
        for ch in value
    ):
        raise ProofError("coordinator returned a non-canonical job id")
    return value
