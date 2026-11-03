import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./server.js";
import { canonicalJson } from "./integration-contract.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRoleTask } from "../worker/execute.js";

const tokens = {
  coordinator: "coordinator-" + "a".repeat(40),
  read: "read-" + "b".repeat(40),
  runner: "runner-" + "c".repeat(40),
  debugger: "debugger-" + "d".repeat(40),
  coder: "coder-" + "e".repeat(40),
  tester: "tester-" + "f".repeat(40),
  governance: "governance-" + "g".repeat(40),
  executor: "executor-" + "h".repeat(40),
};
const executorId = "spiffe://prod/agent/grok-bot";
const executorKeys = generateKeyPairSync("ed25519");
const executorPublicKeyPem = executorKeys.publicKey.export({ type: "spki", format: "pem" });

function signedEvidence(jobId, role, overrides = {}) {
  const now = new Date();
  const report = role === "debugger"
    ? { diagnosis: "reproduced failing condition", reproduction: "node --test reproduction.test.js" }
    : role === "coder"
      ? { artifacts: [{ path: "src/fix.js", sha256: "sha256:" + "a".repeat(64) }] }
      : role === "tester"
        ? { tests: [{ command: "npm test", exit_code: 0 }] }
        : { decision: "approve", checks: [{ name: "artifact and test review", passed: true }] };
  const evidence = {
    schema: "grokbot.swarm-evidence/v1", job_id: jobId, role, executor: executorId,
    run_id: "swarm-" + jobId + "-" + role, status: "succeeded",
    started_at: now.toISOString(), completed_at: new Date(now.getTime() + 1).toISOString(),
    answer_digest: "sha256:" + "b".repeat(64),
    tool_results: [{ tool: "terminal", ok: true, exitCode: 0, stdout_sha256: null, stderr_sha256: null }],
    report, ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalJson(evidence)), executorKeys.privateKey).toString("base64");
  return { evidence, evidence_signature: signature };
}

async function startCoordinator() {
  const stateDir = mkdtempSync(join(tmpdir(), "swarm-grok-e2e-"));
  const server = createServer({
    token: tokens.coordinator, readToken: tokens.read, runnerToken: tokens.runner,
    roleTokens: { debugger: tokens.debugger, coder: tokens.coder, tester: tokens.tester, governance: tokens.governance },
    tenant: "test-tenant", stateDir, executorPublicKeyPem, executorId,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + server.address().port, stateDir };
}

async function startGrokMock(responseFactory) {
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (req.method !== "POST" || req.url !== "/api/swarm/execute" || req.headers.authorization !== "Bearer " + tokens.executor) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const result = responseFactory(body);
    res.writeHead(result.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + server.address().port + "/api/swarm/execute" };
}

test("real coordinator accepts Grok Bot signed evidence and advances the specialist chain", async (t) => {
  const coordinator = await startCoordinator();
  let expectedEvidence;
  const grok = await startGrokMock((body) => {
    expectedEvidence = signedEvidence(body.jobId, body.role);
    return { status: 200, body: expectedEvidence };
  });
  t.after(async () => {
    await new Promise((resolve) => grok.server.close(resolve));
    await new Promise((resolve) => coordinator.server.close(resolve));
    rmSync(coordinator.stateDir, { recursive: true, force: true });
  });
  const created = await fetch(coordinator.url + "/api/jobs", {
    method: "POST", headers: { authorization: "Bearer " + tokens.coordinator, "content-type": "application/json" },
    body: JSON.stringify({ objective: "reproduce and fix a failing route" }),
  });
  assert.equal(created.status, 202);
  const job = await created.json();
  const result = await executeRoleTask({
    job, role: "debugger", coordinatorUrl: coordinator.url, executorUrl: grok.url,
    readToken: tokens.read, roleToken: tokens.debugger, executorToken: tokens.executor, claimToken: "test-claim-token-0123456789abcdef",
  });
  assert.equal(result.reported, true);
  const listed = await fetch(coordinator.url + "/api/jobs", { headers: { authorization: "Bearer " + tokens.read } });
  const state = await listed.json();
  assert.equal(state.jobs[0].step, 1);
  assert.equal(state.jobs[0].status, "running");
  assert.equal(state.jobs[0].events[0].role, "debugger");
  assert.equal(state.jobs[0].events[0].evidence_signature, expectedEvidence.evidence_signature);
});

test("coordinator rejects tampered executor signatures and leaves job unchanged", async (t) => {
  const coordinator = await startCoordinator();
  const grok = await startGrokMock((body) => ({ status: 200, body: { ...signedEvidence(body.jobId, body.role), evidence_signature: "AAAA" } }));
  t.after(async () => {
    await new Promise((resolve) => grok.server.close(resolve));
    await new Promise((resolve) => coordinator.server.close(resolve));
    rmSync(coordinator.stateDir, { recursive: true, force: true });
  });
  const created = await fetch(coordinator.url + "/api/jobs", { method: "POST", headers: { authorization: "Bearer " + tokens.coordinator, "content-type": "application/json" }, body: JSON.stringify({ objective: "reject forged evidence" }) });
  const job = await created.json();
  const result = await executeRoleTask({ job, role: "debugger", coordinatorUrl: coordinator.url, executorUrl: grok.url, readToken: tokens.read, roleToken: tokens.debugger, executorToken: tokens.executor });
  assert.equal(result.reported, false);
  const listed = await fetch(coordinator.url + "/api/jobs", { headers: { authorization: "Bearer " + tokens.read } });
  const state = await listed.json();
  assert.equal(state.jobs[0].step, 0);
  assert.equal(state.jobs[0].events.length, 0);
});

test("coordinator rejects validly signed but out-of-order specialist evidence", async (t) => {
  const coordinator = await startCoordinator();
  const grok = await startGrokMock((body) => ({ status: 200, body: signedEvidence(body.jobId, body.role) }));
  t.after(async () => {
    await new Promise((resolve) => grok.server.close(resolve));
    await new Promise((resolve) => coordinator.server.close(resolve));
    rmSync(coordinator.stateDir, { recursive: true, force: true });
  });
  const created = await fetch(coordinator.url + "/api/jobs", { method: "POST", headers: { authorization: "Bearer " + tokens.coordinator, "content-type": "application/json" }, body: JSON.stringify({ objective: "enforce specialist order" }) });
  const job = await created.json();
  const result = await executeRoleTask({ job, role: "coder", coordinatorUrl: coordinator.url, executorUrl: grok.url, readToken: tokens.read, roleToken: tokens.coder, executorToken: tokens.executor, claimToken: "test-claim-token-0123456789abcdef" });
  assert.equal(result.reported, false);
  assert.match(result.reason, /rejected evidence \(409\)/);
});
