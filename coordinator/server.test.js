import test, { before, after, beforeEach } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "./server.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "./integration-contract.js";

const TOKEN = "test-token-0123456789abcdef0123456789abcdef";
const READ_TOKEN = "read-token-0123456789abcdef0123456789abcdef";
const RUNNER_TOKEN = "runner-token-0123456789abcdef0123456789abcdef";
const ROLE_TOKENS = Object.fromEntries(["debugger", "coder", "tester", "governance"].map((role) => [role, `role-${role}-token-0123456789abcdef`]));
const EXECUTOR_KEYS = generateKeyPairSync("ed25519");
const EXECUTOR_ID = "spiffe://prod/agent/grok-bot";
const EXECUTOR_PUBLIC_KEY_PEM = EXECUTOR_KEYS.publicKey.export({ type: "spki", format: "pem" });
let server;
let base;
let state;

async function start(token = TOKEN, roleTokens = ROLE_TOKENS, readToken = READ_TOKEN, runnerToken = RUNNER_TOKEN, stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-coordinator-test-")), compactAfterRecords = 500, executorConfig = {}) {
  const instance = createServer({
    token, readToken, runnerToken, roleTokens, tenant: "test-tenant", stateDir, compactAfterRecords,
    executorPublicKeyPem: EXECUTOR_PUBLIC_KEY_PEM, executorId: EXECUTOR_ID, ...executorConfig,
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return { instance, base: `http://127.0.0.1:${instance.address().port}`, stateDir };
}
async function stop(instance, { removeState = true } = {}) {
  if (instance?.listening) await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  if (removeState && instance?.stateDir) fs.rmSync(instance.stateDir, { recursive: true, force: true });
}
async function request(path, { method = "GET", body, token, contentType = "application/json", extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  let credential = token;
  if (credential === undefined) {
    if (path.startsWith("/api/events")) credential = ROLE_TOKENS[body?.role];
    else if (/^\/api\/worker\/(debugger|coder|tester|governance)\//.test(path)) credential = ROLE_TOKENS[path.split("/")[3]];
    else if (path.startsWith("/api/runner/")) credential = RUNNER_TOKEN;
    else if (method === "GET" && (path === "/api/jobs" || path.startsWith("/api/search"))) credential = READ_TOKEN;
    else credential = TOKEN;
  }
  if (credential !== null) headers.authorization = `Bearer ${credential}`;
  if (body !== undefined && contentType) headers["content-type"] = contentType;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : body instanceof Uint8Array ? body : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
function signedRoleEvidence(role, payload) {
  const started = new Date();
  const report = role === "debugger"
    ? { diagnosis: "reproduced in test sandbox", reproduction: "node --test fixture" }
    : role === "coder"
      ? { artifacts: [{ path: "src/fix.js", sha256: `sha256:${"a".repeat(64)}` }] }
      : role === "tester"
        ? { tests: [{ command: "npm test", exit_code: 0 }] }
        : {
          decision: "approve",
          artifact_inventory: [{ path: "src/fix.js", sha256: "sha256:" + "a".repeat(64) }],
          test_commands: [{ command: "npm test", exit_code: 0 }],
          checks: [{ name: "signed evidence", passed: true }],
        };
  const evidence = {
    schema: "grokbot.swarm-evidence/v1", job_id: payload.jobId, role, executor: EXECUTOR_ID,
    run_id: `test-run-${payload.jobId}-${role}`,
    status: payload.status === "passed" ? "succeeded" : "failed",
    started_at: started.toISOString(), completed_at: new Date(started.getTime() + 1).toISOString(),
    answer_digest: `sha256:${"b".repeat(64)}`,
    tool_results: payload.status === "passed" ? [{ tool: "terminal", ok: true, exitCode: 0, stdout_sha256: null, stderr_sha256: null }] : [],
    report: payload.status === "passed" ? report : {},
  };
  const evidence_signature = sign(null, Buffer.from(canonicalJson(evidence)), EXECUTOR_KEYS.privateKey).toString("base64");
  return { evidence, evidence_signature };
}
async function event(role, payload) {
  const claim = await request("/api/worker/" + role + "/claim", {
    method: "POST", body: { workerId: "test-" + role, leaseMs: 30000 }, token: ROLE_TOKENS[role],
  });
  const signed = signedRoleEvidence(role, payload);
  return request("/api/events", {
    method: "POST", body: { ...payload, ...signed, role, ...(claim.status === 200 ? { tenant: claim.body.tenant, claimToken: claim.body.claimToken, workerId: claim.body.lease.workerId } : {}) },
    token: ROLE_TOKENS[role],
  });
}
async function createJob(objective = "verify orchestration") {
  const response = await request("/api/jobs", { method: "POST", body: { objective } });
  assert.equal(response.status, 202);
  return response.body;
}

before(async () => {
  state = await start();
  server = state.instance;
  base = state.base;
});
after(async () => stop(server));
beforeEach(() => {});

test("health is public and does not disclose job contents", async () => {
  const response = await request("/health", { token: null });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.tenant, "test-tenant");
  assert.deepEqual(response.body.roles, ["debugger", "coder", "tester", "governance"]);
  assert.equal("objectives" in response.body, false);
});

test("protected API fails closed when coordinator token is not configured", async () => {
  const isolated = await start("");
  const previous = base;
  base = isolated.base;
  try {
    const response = await request("/api/jobs", { method: "POST", body: { objective: "probe" }, token: TOKEN });
    assert.equal(response.status, 503);
  } finally {
    base = previous;
    await stop(isolated.instance);
  }
});

test("reused secrets fail closed instead of silently collapsing capabilities", async () => {
  const reusedRoles = Object.fromEntries(["debugger", "coder", "tester", "governance"].map((role) => [role, TOKEN]));
  const isolated = await start(TOKEN, reusedRoles, TOKEN, TOKEN);
  const previous = base;
  base = isolated.base;
  try {
    assert.equal((await request("/api/jobs", { token: TOKEN })).status, 503);
  } finally {
    base = previous;
    await stop(isolated.instance);
  }
});

test("read, coordinator, runner and role credentials are isolated by capability", async () => {
  assert.equal((await request("/api/jobs", { token: TOKEN })).status, 401);
  assert.equal((await request("/api/jobs", { method: "POST", body: { objective: "no" }, token: READ_TOKEN })).status, 401);
  assert.equal((await request("/api/jobs", { method: "POST", body: { objective: "no" }, token: RUNNER_TOKEN })).status, 401);
  assert.equal((await request("/api/runner/jobs", { method: "POST", body: { kind: "health-probe" }, token: TOKEN })).status, 401);
  assert.equal((await request("/api/jobs", { method: "POST", body: { objective: "no" }, token: ROLE_TOKENS.debugger })).status, 401);
});

test("missing and incorrect bearer credentials are rejected", async () => {
  assert.equal((await request("/api/jobs", { token: null })).status, 401);
  assert.equal((await request("/api/jobs", { token: "wrong-token-0123456789abcdef0123456789abcdef" })).status, 401);
});

test("job creation validates objective type, emptiness and maximum length", async () => {
  for (const objective of [null, 12, {}, "", "  ", "x".repeat(2001)]) {
    assert.equal((await request("/api/jobs", { method: "POST", body: { objective } })).status, 400);
  }
  assert.equal((await request("/api/jobs", { method: "POST", body: { objective: "x".repeat(2000) } })).status, 202);
});

test("malformed, non-object and oversized JSON bodies are rejected", async () => {
  assert.equal((await request("/api/jobs", { method: "POST", body: "{" })).status, 400);
  assert.equal((await request("/api/jobs", { method: "POST", body: "[]" })).status, 400);
  assert.equal((await request("/api/jobs", { method: "POST", body: "x".repeat(17000) })).status, 413);
});

test("invalid UTF-8 request bytes are rejected", async () => {
  const response = await request("/api/jobs", { method: "POST", body: new Uint8Array([0xff, 0xfe, 0x80]) });
  assert.equal(response.status, 400);
});

test("JSON endpoints reject incorrect content type", async () => {
  assert.equal((await request("/api/jobs", { method: "POST", body: "objective=hello", contentType: "text/plain" })).status, 415);
});

test("worker event routes fail closed when a role credential is missing", async () => {
  const isolated = await start(TOKEN, {});
  const previous = base;
  base = isolated.base;
  try {
    const response = await request("/api/events", { method: "POST", body: { jobId: "missing", role: "debugger", status: "passed" }, token: ROLE_TOKENS.debugger });
    assert.equal(response.status, 503);
  } finally {
    base = previous;
    await stop(isolated.instance);
  }
});

test("concurrent duplicate role reports have exactly one winner", async () => {
  const job = await createJob();
  const results = await Promise.all([
    event("debugger", { jobId: job.id, status: "passed", note: "first" }),
    event("debugger", { jobId: job.id, status: "passed", note: "second" }),
  ]);
  const statuses = results.map((result) => result.status);
  assert.equal(statuses.filter(status => status === 200).length, 1);
  assert.ok(statuses.every(status => status === 200 || status === 403 || status === 409));
  const stored = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
  assert.equal(stored.events.filter((item) => item.role === "debugger").length, 1);
});

test("worker role cannot pass a job with missing or mismatched Grok Bot evidence", async () => {
  const job = await createJob("signed evidence boundary");
  const claim = await request("/api/worker/debugger/claim", {
    method: "POST", body: { workerId: "evidence-worker", leaseMs: 30000 }, token: ROLE_TOKENS.debugger,
  });
  assert.equal(claim.status, 200);
  const claimFields = { claimToken: claim.body.claimToken, workerId: claim.body.lease.workerId };
  const missing = await request("/api/events", {
    method: "POST",
    body: { jobId: job.id, tenant: claim.body.tenant, role: "debugger", status: "passed", ...claimFields },
    token: ROLE_TOKENS.debugger,
  });
  assert.equal(missing.status, 403);
  const signed = signedRoleEvidence("debugger", { jobId: job.id, status: "passed" });
  const mismatched = { ...signed.evidence, job_id: "job-forged" };
  const rejected = await request("/api/events", {
    method: "POST",
    body: { jobId: job.id, tenant: claim.body.tenant, role: "debugger", status: "passed", evidence: mismatched, evidence_signature: signed.evidence_signature, ...claimFields },
    token: ROLE_TOKENS.debugger,
  });
  assert.equal(rejected.status, 403);
  assert.equal((await request("/api/jobs")).body.jobs.find((item) => item.id === job.id).events.length, 0);
});

test("worker events require the dedicated role token, not the coordinator token", async () => {
  const job = await createJob();
  const denied = await request("/api/events", { method: "POST", body: { jobId: job.id, role: "debugger", status: "passed" }, token: TOKEN });
  assert.equal(denied.status, 401);
  const accepted = await event("debugger", { jobId: job.id, status: "passed" });
  assert.equal(accepted.status, 200);
});

test("only the expected role may advance a job, in strict order", async () => {
  const job = await createJob();
  const wrong = await event("coder", { jobId: job.id, status: "passed" });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.expectedRole, "debugger");
  const first = await event("debugger", { jobId: job.id, status: "passed", note: "ok" });
  assert.equal(first.status, 200);
  assert.equal(first.body.step, 1);
  assert.equal(first.body.status, "running");
});

test("duplicate role reports and invalid event states cannot advance the chain", async () => {
  const job = await createJob();
  assert.equal((await event("debugger", { jobId: job.id, status: "running" })).status, 400);
  await event("debugger", { jobId: job.id, status: "passed" });
  const duplicate = await event("debugger", { jobId: job.id, status: "passed" });
  assert.equal(duplicate.status, 409);
  assert.equal((await event("debugger", { jobId: "missing", status: "passed" })).status, 404);
});

test("failed role terminates job and later role events are refused", async () => {
  const job = await createJob();
  const failed = await event("debugger", { jobId: job.id, status: "failed", note: "blocked" });
  assert.equal(failed.body.status, "failed");
  assert.equal((await event("coder", { jobId: job.id, status: "passed" })).status, 409);
});

test("all four ordered roles are required before a job completes", async () => {
  const job = await createJob();
  for (const role of ["debugger", "coder", "tester", "governance"]) {
    const response = await event(role, { jobId: job.id, status: "passed", note: "done".repeat(300) });
    assert.equal(response.status, 200);
    assert.ok(response.body.events.at(-1).note.length <= 500);
  }
  const final = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
  assert.equal(final.status, "completed");
  assert.equal(final.events.length, 4);
  assert.equal((await event("governance", { jobId: job.id, status: "passed" })).status, 409);
});

test("worker refuses to start without Grok Bot executor credentials and never fabricates a pass", async () => {
  const job = await createJob("prove worker executor is absent");
  const workerPath = fileURLToPath(new URL("../worker/worker.js", import.meta.url));
  const child = spawn(process.execPath, [workerPath], {
    env: { ...process.env, ROLE: "debugger", COORDINATOR_URL: base, SWARM_READ_TOKEN: READ_TOKEN, SWARM_ROLE_TOKEN: ROLE_TOKENS.debugger, SWARM_EXECUTOR_TOKEN: "" },
    stdio: "ignore",
  });
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(exitCode, 0);
  const current = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
  assert.equal(current.status, "queued");
  assert.equal(current.events.length, 0);
});

test("job and runner state survive coordinator restart with stale claims invalidated", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-coordinator-restart-"));
  const previous = base;
  const first = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
  base = first.base;
  let claimed;
  let job;
  try {
    job = await createJob("persist me");
    await event("debugger", { jobId: job.id, status: "passed", note: "durable receipt" });
    const queued = await request("/api/runner/jobs", { method: "POST", body: { kind: "inventory", objective: "resume me" } });
    claimed = (await request("/api/runner/claim", { method: "POST", body: { runner: "worker-a" } })).body;
    assert.equal(claimed.id, queued.body.id);
    await stop(first.instance, { removeState: false });

    const second = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
    base = second.base;
    const restored = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
    assert.equal(restored.status, "running");
    assert.equal(restored.events.length, 1);
    const requeued = (await request("/api/runner/jobs", { method: "GET" })).body.jobs.find((item) => item.id === claimed.id);
    assert.equal(requeued.status, "queued");
    const newClaim = (await request("/api/runner/claim", { method: "POST", body: { runner: "worker-a" } })).body;
    assert.notEqual(newClaim.claimToken, claimed.claimToken);
    assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: claimed.id, runner: "worker-a", claimToken: claimed.claimToken, ok: true } })).status, 403);
    assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: newClaim.id, runner: "worker-a", claimToken: newClaim.claimToken, ok: true } })).status, 200);
    await stop(second.instance);
  } finally {
    base = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("journal recovery ignores only an incomplete final append", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-coordinator-tail-"));
  const previous = base;
  const first = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
  base = first.base;
  let job;
  try {
    job = await createJob("journal tail recovery");
    await stop(first.instance, { removeState: false });
    fs.appendFileSync(path.join(stateDir, "coordinator.jsonl"), "{truncated-record");
    const second = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
    base = second.base;
    const restored = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
    assert.equal(restored.objective, "journal tail recovery");
    const nextJob = await createJob("append after repaired tail");
    assert.equal(nextJob.id, "job-2");
    await stop(second.instance, { removeState: false });
    const third = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
    base = third.base;
    const afterSecondRestart = (await request("/api/jobs")).body.jobs;
    assert.equal(afterSecondRestart.length, 2);
    assert.ok(afterSecondRestart.some((item) => item.id === nextJob.id));
    await stop(third.instance);
  } finally {
    base = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a live append repairs a torn journal tail before writing the next record", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-coordinator-live-tail-"));
  const previous = base;
  const instance = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
  base = instance.base;
  try {
    const first = await createJob("before torn tail");
    fs.appendFileSync(path.join(stateDir, "coordinator.jsonl"), "{partial-live-write");
    const second = await createJob("after torn tail");
    assert.equal(first.id, "job-1");
    assert.equal(second.id, "job-2");
    await stop(instance.instance, { removeState: false });
    const restarted = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
    base = restarted.base;
    const restored = (await request("/api/jobs")).body.jobs;
    assert.equal(restored.length, 2);
    assert.ok(restored.some((item) => item.objective === "after torn tail"));
    await stop(restarted.instance);
  } finally {
    base = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("journal compaction preserves latest job and runner state across restart", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-coordinator-compact-"));
  const previous = base;
  const first = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir, 3);
  base = first.base;
  try {
    const job = await createJob("compact state");
    await event("debugger", { jobId: job.id, status: "passed", note: "before compact" });
    const queued = await request("/api/runner/jobs", { method: "POST", body: { kind: "inventory", objective: "compact runner" } });
    const runner = (await request("/api/runner/claim", { method: "POST", body: { runner: "worker-c" } })).body;
    assert.equal(runner.id, queued.body.id);
    await stop(first.instance, { removeState: false });
    const second = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir, 3);
    base = second.base;
    const restored = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
    assert.equal(restored.events.length, 1);
    const restoredRunner = (await request("/api/runner/jobs", { method: "GET" })).body.jobs.find((item) => item.id === runner.id);
    assert.equal(restoredRunner.status, "queued");
    await stop(second.instance);
  } finally {
    base = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runner jobs are allowlisted and claims are single-owner", async () => {
  assert.equal((await request("/api/runner/jobs", { method: "POST", body: { kind: "shell", objective: "bad" } })).status, 400);
  const queued = await request("/api/runner/jobs", { method: "POST", body: { kind: "health-probe", objective: "check" } });
  assert.equal(queued.status, 202);
  const claim = await request("/api/runner/claim", { method: "POST", body: { runner: "worker-a" } });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.status, "running");
  assert.equal(claim.body.runner, "worker-a");
  assert.equal((await request("/api/runner/claim", { method: "POST", body: { runner: "worker-b" } })).status, 204);
});

test("runner completion requires owning runner, boolean outcome and active state", async () => {
  const queued = await request("/api/runner/jobs", { method: "POST", body: { kind: "inventory", objective: "inventory" } });
  const job = (await request("/api/runner/claim", { method: "POST", body: { runner: "worker-a" } })).body;
  assert.equal(job.id, queued.body.id);
  assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: job.id, runner: "worker-b", claimToken: job.claimToken, ok: true } })).status, 403);
  assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: job.id, runner: "worker-a", claimToken: job.claimToken, ok: "yes" } })).status, 400);
  assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: job.id, runner: "worker-a", claimToken: job.claimToken, ok: true, note: "done" } })).status, 200);
  assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: job.id, runner: "worker-a", claimToken: job.claimToken, ok: true } })).status, 409);
});

test("runner status listing never exposes a live claim token", async () => {
  const queued = await request("/api/runner/jobs", {
    method: "POST", body: { kind: "inventory", objective: "do not leak lease credentials" },
  });
  const claimed = await request("/api/runner/claim", {
    method: "POST", body: { runner: "worker-secret-owner" },
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.id, queued.body.id);
  assert.equal(typeof claimed.body.claimToken, "string");
  const listed = await request("/api/runner/jobs");
  const visible = listed.body.jobs.find((item) => item.id === queued.body.id);
  assert.ok(visible);
  assert.equal("claimToken" in visible, false);
  assert.equal(visible.runner, "worker-secret-owner");
  const completed = await request("/api/runner/complete", {
    method: "POST",
    body: { id: claimed.body.id, runner: "worker-secret-owner", claimToken: claimed.body.claimToken, ok: true },
  });
  assert.equal(completed.status, 200);
});

test("expired runner lease cannot complete before reclamation and stale token stays fenced", async () => {
  let clock = Date.now();
  const isolated = await start(
    TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN,
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runner-lease-expiry-")),
    500, { now: () => clock },
  );
  const previous = base;
  base = isolated.base;
  try {
    const queued = await request("/api/runner/jobs", {
      method: "POST", body: { kind: "inventory", objective: "lease must expire" },
    });
    const first = await request("/api/runner/claim", {
      method: "POST", body: { runner: "worker-a" },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.id, queued.body.id);
    assert.equal(first.body.leaseExpiresAt, clock + 30000);

    clock += 30001;
    const staleCompletion = await request("/api/runner/complete", {
      method: "POST",
      body: { id: first.body.id, runner: "worker-a", claimToken: first.body.claimToken, ok: true },
    });
    assert.equal(staleCompletion.status, 409);
    assert.match(staleCompletion.body.error, /expired/);

    const second = await request("/api/runner/claim", {
      method: "POST", body: { runner: "worker-b" },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.notEqual(second.body.claimToken, first.body.claimToken);

    const staleAfterReclaim = await request("/api/runner/complete", {
      method: "POST",
      body: { id: second.body.id, runner: "worker-a", claimToken: first.body.claimToken, ok: true },
    });
    assert.equal(staleAfterReclaim.status, 403);

    const currentCompletion = await request("/api/runner/complete", {
      method: "POST",
      body: { id: second.body.id, runner: "worker-b", claimToken: second.body.claimToken, ok: true },
    });
    assert.equal(currentCompletion.status, 200);
    assert.equal(currentCompletion.body.status, "completed");
  } finally {
    base = previous;
    await stop(isolated.instance);
  }
});

test("runner lease renewal keeps long work valid and never returns the claim token", async () => {
  let clock = Date.now();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runner-renew-"));
  const isolated = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir, 500, { now: () => clock });
  const previous = base;
  base = isolated.base;
  try {
    const queued = await request("/api/runner/jobs", {
      method: "POST", body: { kind: "inventory", objective: "renew this runner lease" },
    });
    const first = await request("/api/runner/claim", {
      method: "POST", body: { runner: "worker-renew", leaseMs: 10000 },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.id, queued.body.id);
    assert.equal(first.body.leaseExpiresAt, clock + 10000);

    const wrongRunner = await request("/api/runner/renew", {
      method: "POST",
      body: { id: first.body.id, runner: "worker-other", claimToken: first.body.claimToken, leaseMs: 15000 },
    });
    assert.equal(wrongRunner.status, 403);
    const wrongToken = await request("/api/runner/renew", {
      method: "POST",
      body: { id: first.body.id, runner: "worker-renew", claimToken: "x".repeat(40), leaseMs: 15000 },
    });
    assert.equal(wrongToken.status, 403);

    clock += 8000;
    const renewed = await request("/api/runner/renew", {
      method: "POST",
      body: { id: first.body.id, runner: "worker-renew", claimToken: first.body.claimToken, leaseMs: 15000 },
    });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.leaseExpiresAt, clock + 15000);
    assert.equal("claimToken" in renewed.body, false);

    // The original 10-second expiry has passed, but the current renewed lease is valid.
    clock += 3000;
    const completed = await request("/api/runner/complete", {
      method: "POST",
      body: { id: first.body.id, runner: "worker-renew", claimToken: first.body.claimToken, ok: true },
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, "completed");
  } finally {
    base = previous;
    await stop(isolated.instance);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runner renewal rejects invalid and expired lease durations and cannot revive a stale lease", async () => {
  let clock = Date.now();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runner-renew-reject-"));
  const isolated = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir, 500, { now: () => clock });
  const previous = base;
  base = isolated.base;
  try {
    const queued = await request("/api/runner/jobs", {
      method: "POST", body: { kind: "inventory", objective: "reject unsafe lease values" },
    });
    const invalidClaim = await request("/api/runner/claim", {
      method: "POST", body: { runner: "worker-a", leaseMs: 4999 },
    });
    assert.equal(invalidClaim.status, 400);
    const first = await request("/api/runner/claim", {
      method: "POST", body: { runner: "worker-a", leaseMs: 10000 },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.id, queued.body.id);

    for (const leaseMs of [4999, 120001, 5000.5, "10000"]) {
      const invalidRenewal = await request("/api/runner/renew", {
        method: "POST",
        body: { id: first.body.id, runner: "worker-a", claimToken: first.body.claimToken, leaseMs },
      });
      assert.equal(invalidRenewal.status, 400, String(leaseMs));
    }

    clock += 10001;
    const expiredRenewal = await request("/api/runner/renew", {
      method: "POST",
      body: { id: first.body.id, runner: "worker-a", claimToken: first.body.claimToken, leaseMs: 30000 },
    });
    assert.equal(expiredRenewal.status, 409);

    const second = await request("/api/runner/claim", {
      method: "POST", body: { runner: "worker-b", leaseMs: 10000 },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    const staleRenewal = await request("/api/runner/renew", {
      method: "POST",
      body: { id: second.body.id, runner: "worker-a", claimToken: first.body.claimToken, leaseMs: 10000 },
    });
    assert.equal(staleRenewal.status, 403);
    const validRenewal = await request("/api/runner/renew", {
      method: "POST",
      body: { id: second.body.id, runner: "worker-b", claimToken: second.body.claimToken, leaseMs: 10000 },
    });
    assert.equal(validRenewal.status, 200);
  } finally {
    base = previous;
    await stop(isolated.instance);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("job idempotency returns the same job, rejects changed objectives, and hides key material", async () => {
  const key = "spawn:run-123";
  const first = await request("/api/jobs", {
    method: "POST", body: { objective: "create exactly one child job" },
    extraHeaders: { "idempotency-key": key },
  });
  assert.equal(first.status, 202);
  const replay = await request("/api/jobs", {
    method: "POST", body: { objective: "  create exactly one child job  " },
    extraHeaders: { "idempotency-key": key },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(replay.body.idempotent_replay, true);

  const conflict = await request("/api/jobs", {
    method: "POST", body: { objective: "create a different child job" },
    extraHeaders: { "idempotency-key": key },
  });
  assert.equal(conflict.status, 409);

  for (const badKey of ["", "bad/key", "contains spaces", "x".repeat(129)]) {
    const response = await request("/api/jobs", {
      method: "POST", body: { objective: "reject malformed key" },
      extraHeaders: { "idempotency-key": badKey },
    });
    assert.equal(response.status, 400, JSON.stringify(badKey));
  }
  const listed = await request("/api/jobs");
  const visible = listed.body.jobs.find(job => job.id === first.body.id);
  assert.ok(visible);
  assert.equal("idempotencyKey" in visible, false);
  assert.equal("idempotencyDigest" in visible, false);

  const claim = await request("/api/worker/debugger/claim", {
    method: "POST",
    body: { workerId: "worker-idempotency-redaction" },
    token: ROLE_TOKENS.debugger,
  });
  assert.equal(claim.status, 200);
  const signed = signedRoleEvidence("debugger", { jobId: first.body.id, status: "passed" });
  const event = await request("/api/events", {
    method: "POST",
    body: {
      jobId: first.body.id, role: "debugger", status: "passed", ...signed,
      tenant: claim.body.tenant, claimToken: claim.body.claimToken,
      workerId: claim.body.lease.workerId,
    },
    token: ROLE_TOKENS.debugger,
  });
  assert.equal(event.status, 200);
  assert.equal("idempotencyKey" in event.body, false);
  assert.equal("idempotencyDigest" in event.body, false);
});

test("concurrent and post-restart job idempotency creates one durable child", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-job-idempotency-"));
  const previous = base;
  let isolated = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir, 3);
  base = isolated.base;
  const key = "spawn:run-persistent";
  try {
    const requests = await Promise.all(Array.from({ length: 8 }, () => request("/api/jobs", {
      method: "POST",
      body: { objective: "one subagent across concurrent retries" },
      extraHeaders: { "idempotency-key": key },
    })));
    assert.equal(requests.filter(result => result.status === 202).length, 1);
    assert.equal(requests.filter(result => result.status === 200).length, 7);
    assert.equal(new Set(requests.map(result => result.body.id)).size, 1);
    const jobId = requests[0].body.id;

    await stop(isolated.instance, { removeState: false });
    isolated = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir, 3);
    base = isolated.base;
    const afterRestart = await request("/api/jobs", {
      method: "POST",
      body: { objective: "one subagent across concurrent retries" },
      extraHeaders: { "idempotency-key": key },
    });
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.body.id, jobId);
    const jobs = await request("/api/jobs");
    assert.equal(jobs.body.jobs.filter(job => job.id === jobId).length, 1);
  } finally {
    base = previous;
    await stop(isolated.instance);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("search is authenticated and query length is bounded", async () => {
  assert.equal((await request("/api/search?q=xy", { token: null })).status, 401);
  assert.equal((await request(`/api/search?q=${"x".repeat(81)}`)).status, 400);
  assert.equal((await request("/api/search?q=job")).status, 200);
});


test("internal prove-success runner fails closed without a verifiable proof adapter", async () => {
  const queued = await request("/api/runner/jobs", {
    method: "POST",
    body: { kind: "prove-success", objective: "prove this exact job" },
  });
  assert.equal(queued.status, 202);
  const runnerPath = fileURLToPath(new URL("../internal-runner/runner.mjs", import.meta.url));
  const child = spawn(process.execPath, [runnerPath], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      COORDINATOR_URL: base,
      INTERNAL_RUNNER_NAME: "test-proof-runner",
      SWARM_ROOT: fileURLToPath(new URL("..", import.meta.url)),
      SWARM_API_TOKEN: TOKEN,
      SWARM_READ_TOKEN: READ_TOKEN,
      SWARM_RUNNER_TOKEN: RUNNER_TOKEN,
      POLL_MS: "100",
    },
    stdio: "ignore",
  });
  try {
    let completed;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const jobs = (await request("/api/runner/jobs")).body.jobs;
      completed = jobs.find((job) => job.id === queued.body.id);
      if (completed?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(completed?.status, "failed");
    assert.match(completed.note, /no verifiable proof adapter/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});


test("specialist claim is atomic under concurrent same-role workers", async () => {
  const job = await createJob("concurrent specialist claim");
  const claims = await Promise.all([
    request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-a" }, token: ROLE_TOKENS.debugger }),
    request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-b" }, token: ROLE_TOKENS.debugger }),
  ]);
  assert.deepEqual(claims.map((item) => item.status).sort(), [200, 204]);
  const winner = claims.find((item) => item.status === 200).body;
  assert.equal(winner.id, job.id);
  const visible = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
  assert.equal(visible.lease.claimToken, undefined);
});

test("claim rejects invalid worker identities, lease bounds, and wrong role credentials", async () => {
  assert.equal((await request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "../escape" }, token: ROLE_TOKENS.debugger })).status, 400);
  for (const leaseMs of [0, -1, 999, 600001, 1.5, "1000", null]) {
    assert.equal((await request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-a", leaseMs }, token: ROLE_TOKENS.debugger })).status, 400);
  }
  assert.equal((await request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-a" }, token: TOKEN })).status, 401);
});

test("capacity-rejected worker can safely release its exact active lease", async () => {
  const job = await createJob("release capacity claim");
  const claim = await request("/api/worker/debugger/claim", {
    method: "POST", body: { workerId: "worker-a", leaseMs: 30000 }, token: ROLE_TOKENS.debugger,
  });
  assert.equal(claim.status, 200);
  const releaseBody = { jobId: job.id, tenant: job.tenant, workerId: "worker-a", claimToken: claim.body.claimToken };
  assert.equal((await request("/api/worker/debugger/release", { method: "POST", body: { ...releaseBody, workerId: "worker-b" }, token: ROLE_TOKENS.debugger })).status, 403);
  assert.equal((await request("/api/worker/debugger/release", { method: "POST", body: { ...releaseBody, tenant: "another-tenant" }, token: ROLE_TOKENS.debugger })).status, 403);
  assert.equal((await request("/api/worker/debugger/release", { method: "POST", body: releaseBody, token: ROLE_TOKENS.debugger })).status, 200);
  const next = await request("/api/worker/debugger/claim", {
    method: "POST", body: { workerId: "worker-b", leaseMs: 30000 }, token: ROLE_TOKENS.debugger,
  });
  assert.equal(next.status, 200);
  assert.notEqual(next.body.claimToken, claim.body.claimToken);
});

test("external executor can validate only the current active specialist claim", async () => {
  const job = await createJob("validate executor claim");
  const claim = await request("/api/worker/debugger/claim", {
    method: "POST", body: { workerId: "worker-a", leaseMs: 30000 }, token: ROLE_TOKENS.debugger,
  });
  assert.equal(claim.status, 200);
  const validBody = { jobId: job.id, tenant: job.tenant, workerId: "worker-a", claimToken: claim.body.claimToken };
  assert.equal((await request("/api/worker/debugger/validate", { method: "POST", body: validBody, token: ROLE_TOKENS.debugger })).status, 200);
  assert.equal((await request("/api/worker/debugger/validate", { method: "POST", body: { ...validBody, workerId: "worker-b" }, token: ROLE_TOKENS.debugger })).status, 403);
  assert.equal((await request("/api/worker/debugger/validate", { method: "POST", body: { ...validBody, tenant: "another-tenant" }, token: ROLE_TOKENS.debugger })).status, 403);
  assert.equal((await request("/api/worker/debugger/validate", { method: "POST", body: validBody, token: ROLE_TOKENS.coder })).status, 401);
});

test("external executor claim validation rejects an expired lease", async () => {
  let clock = 200000;
  const isolated = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, fs.mkdtempSync(path.join(os.tmpdir(), "swarm-validate-expired-")), 500, { now: () => clock });
  const previous = base;
  base = isolated.base;
  try {
    const job = await createJob("validate expired claim");
    const claim = await request("/api/worker/debugger/claim", {
      method: "POST", body: { workerId: "worker-a", leaseMs: 1000 }, token: ROLE_TOKENS.debugger,
    });
    assert.equal(claim.status, 200);
    const body = { jobId: job.id, tenant: job.tenant, workerId: "worker-a", claimToken: claim.body.claimToken };
    assert.equal((await request("/api/worker/debugger/validate", { method: "POST", body, token: ROLE_TOKENS.debugger })).status, 200);
    clock += 1001;
    assert.equal((await request("/api/worker/debugger/validate", { method: "POST", body, token: ROLE_TOKENS.debugger })).status, 409);
  } finally {
    base = previous;
    await stop(isolated.instance);
  }
});

test("claim lease can be renewed and rejects mismatched identity or token", async () => {
  const job = await createJob("renew lease");
  const claim = await request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-a" }, token: ROLE_TOKENS.debugger });
  assert.equal(claim.status, 200);
  assert.equal((await request("/api/worker/debugger/renew", { method: "POST", body: { jobId: job.id, workerId: "worker-b", claimToken: claim.body.claimToken }, token: ROLE_TOKENS.debugger })).status, 403);
  assert.equal((await request("/api/worker/debugger/renew", { method: "POST", body: { jobId: job.id, workerId: "worker-a", claimToken: "x".repeat(36) }, token: ROLE_TOKENS.debugger })).status, 403);
  assert.equal((await request("/api/worker/debugger/renew", { method: "POST", body: { jobId: job.id, workerId: "worker-a", claimToken: claim.body.claimToken, leaseMs: 45000 }, token: ROLE_TOKENS.debugger })).status, 200);
});

test("expired lease is reclaimed with a new token and stale completion is rejected", async () => {
  let clock = 100000;
  const isolated = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, fs.mkdtempSync(path.join(os.tmpdir(), "swarm-lease-expiry-")), 500, { now: () => clock });
  const previous = base;
  base = isolated.base;
  try {
    const job = await createJob("expire and reclaim");
    const first = await request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-a", leaseMs: 1000 }, token: ROLE_TOKENS.debugger });
    assert.equal(first.status, 200);
    clock += 1001;
    const second = await request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-b", leaseMs: 1000 }, token: ROLE_TOKENS.debugger });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.claimToken, first.body.claimToken);
    const signed = signedRoleEvidence("debugger", { jobId: job.id, status: "passed" });
    const stale = await request("/api/events", { method: "POST", body: { jobId: job.id, role: "debugger", status: "passed", ...signed, tenant: first.body.tenant, claimToken: first.body.claimToken, workerId: first.body.lease.workerId }, token: ROLE_TOKENS.debugger });
    assert.equal(stale.status, 403);
  } finally {
    base = previous;
    await stop(isolated.instance);
  }
});

test("active specialist lease survives restart and remains protected until expiry", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-lease-restart-"));
  const previous = base;
  const first = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
  base = first.base;
  try {
    const job = await createJob("persist active lease");
    const claim = await request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-a", leaseMs: 60000 }, token: ROLE_TOKENS.debugger });
    assert.equal(claim.status, 200);
    await stop(first.instance, { removeState: false });
    const second = await start(TOKEN, ROLE_TOKENS, READ_TOKEN, RUNNER_TOKEN, stateDir);
    base = second.base;
    assert.equal((await request("/api/worker/debugger/claim", { method: "POST", body: { workerId: "worker-b" }, token: ROLE_TOKENS.debugger })).status, 204);
    const signed = signedRoleEvidence("debugger", { jobId: job.id, status: "passed" });
    const accepted = await request("/api/events", { method: "POST", body: { jobId: job.id, role: "debugger", status: "passed", ...signed, tenant: claim.body.tenant, claimToken: claim.body.claimToken, workerId: claim.body.lease.workerId }, token: ROLE_TOKENS.debugger });
    assert.equal(accepted.status, 200);
    await stop(second.instance);
  } finally {
    base = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
