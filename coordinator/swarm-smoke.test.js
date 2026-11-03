import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { canonicalJson } from "./integration-contract.js";
import { buildSmokeObjective, smokeArtifactPaths, smokeArtifactExpectations, smokeCoordinatorToken, boundedInteger, validateCompletedJob } from "./swarm-smoke.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const nowMs = 1730000000000;
const executor = "spiffe://prod/agent/grok-bot";
const jobId = "job-88";
const tenant = "control12";
const expectedArtifacts = smokeArtifactExpectations("smoke-run");
const expectedTestCommand = "node --test " + expectedArtifacts[1].path;

const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");

function makeEvent(role, report) {
  const evidence = {
    schema: "grokbot.swarm-evidence/v1",
    job_id: jobId,
    role,
    executor,
    run_id: "run-" + role,
    status: "succeeded",
    started_at: new Date(nowMs - 1000).toISOString(),
    completed_at: new Date(nowMs).toISOString(),
    answer_digest: digest("answer " + role),
    tool_results: [{
      tool: "terminal", ok: true, exitCode: 0,
      stdout_sha256: digest("stdout"), stderr_sha256: digest("stderr")
    }],
    report
  };
  const evidence_signature = sign(null, Buffer.from(canonicalJson(evidence)), privateKey).toString("base64");
  return { role, status: "passed", evidence, evidence_signature };
}

function validJob() {
  return {
    id: jobId, tenant, status: "completed",
    events: [
      makeEvent("debugger", { diagnosis: "Inspected the source and found no blocker.", reproduction: "pwd && git status --short" }),
      makeEvent("coder", { artifacts: expectedArtifacts }),
      makeEvent("tester", { tests: [{ command: expectedTestCommand, exit_code: 0 }] }),
      makeEvent("governance", { decision: "approve", checks: [
        { name: "successful terminal execution", passed: true },
        { name: "artifact inventory", passed: true },
        { name: "successful test command", passed: true },
        { name: "explicit governance approval", passed: true }
      ] })
    ]
  };
}

test("smoke objective creates a bounded, non-destructive, executable four-role task", () => {
  const objective = buildSmokeObjective("smoke-abc123", "https://github.com/example/repo.git", "main");
  assert.match(objective, /swarm-smoke-smoke-abc123\.txt/);
  assert.deepEqual(smokeArtifactPaths("smoke-abc123"), { textFile: "swarm-smoke-smoke-abc123.txt", testFile: "swarm-smoke-smoke-abc123.test.js" });
  assert.match(objective, /node --test swarm-smoke-smoke-abc123\.test\.js/);
  assert.match(objective, /Do not commit, push, publish/);
  assert.match(objective, /Governance: independently inspect/);
  assert.ok(objective.length <= 2000);
  assert.equal(smokeCoordinatorToken({ SWARM_API_TOKEN: "compose-api-token" }), "compose-api-token");
  assert.equal(smokeCoordinatorToken({ SWARM_TOKEN: "legacy-token" }), "legacy-token");
  assert.equal(smokeCoordinatorToken({}), "");
  assert.equal(boundedInteger("900000", 900000, 60000, 3600000), 900000);
  assert.equal(boundedInteger("-1", 900000, 60000, 3600000), 60000);
  assert.equal(boundedInteger("99999999", 900000, 60000, 3600000), 3600000);
  assert.equal(boundedInteger("NaN", 900000, 60000, 3600000), 900000);
  assert.throws(() => buildSmokeObjective("../escape", "https://github.com/example/repo.git"), /run tag/);
  assert.throws(() => buildSmokeObjective("smoke-1", "file:\/\/etc\/passwd"), /HTTPS Git URL/);
});

test("smoke verifier accepts four ordered signed events and returns a compact receipt", () => {
  const summary = validateCompletedJob(validJob(), {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  });
  assert.equal(summary.status, "completed");
  assert.equal(summary.artifactCount, 1);
  assert.deepEqual(summary.roles.map(item => item.role), ["debugger", "coder", "tester", "governance"]);
  assert.equal(summary.governance, "approve");
});

test("smoke verifier rejects a job from another tenant or job ID", () => {
  const job = validJob();
  assert.throws(() => validateCompletedJob({ ...job, tenant: "other-tenant" }, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /identity, tenant/);
  assert.throws(() => validateCompletedJob(job, {
    expectedJobId: "job-other", expectedTenant: tenant, expectedExecutor: executor, publicKeyPem, nowMs
  }), /identity, tenant/);
});

test("smoke verifier rejects missing, reordered, or duplicate specialist events", () => {
  const job = validJob();
  assert.throws(() => validateCompletedJob({ ...job, events: job.events.slice(0, 3) }, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /exactly four/);
  const reordered = validJob();
  [reordered.events[0], reordered.events[1]] = [reordered.events[1], reordered.events[0]];
  assert.throws(() => validateCompletedJob(reordered, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /role order/);
});

test("smoke verifier rejects invalid executor signatures", () => {
  const job = validJob();
  job.events[1].evidence_signature = Buffer.from("not-a-signature").toString("base64");
  assert.throws(() => validateCompletedJob(job, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /invalid executor evidence signature/);
});

test("smoke verifier rejects failed or fabricated tester evidence", () => {
  const job = validJob();
  job.events[2] = makeEvent("tester", { tests: [{ command: "npm test", exit_code: 1 }] });
  assert.throws(() => validateCompletedJob(job, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /role-specific evidence report/);
});

test("smoke verifier rejects malformed coder artifacts and governance rejection", () => {
  const malformed = validJob();
  malformed.events[1] = makeEvent("coder", { artifacts: [{ path: "../escape", sha256: "bad" }] });
  assert.throws(() => validateCompletedJob(malformed, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /role-specific evidence report|coder artifacts|smoke artifact paths or exact content hashes/);
  const rejected = validJob();
  rejected.events[3] = makeEvent("governance", { decision: "reject", checks: [{ name: "tests", passed: false }] });
  assert.throws(() => validateCompletedJob(rejected, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /role-specific evidence report|governance/);
});

test("smoke verifier rejects failed event status and non-completed jobs", () => {
  const failed = validJob();
  failed.events[0].status = "failed";
  assert.throws(() => validateCompletedJob(failed, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /specialist event failed/);
  const running = validJob();
  running.status = "running";
  assert.throws(() => validateCompletedJob(running, {
    expectedJobId: jobId, expectedTenant: tenant, expectedExecutor: executor,
    expectedArtifacts, expectedTestCommand, publicKeyPem, nowMs
  }), /identity, tenant, or completion/);
});
