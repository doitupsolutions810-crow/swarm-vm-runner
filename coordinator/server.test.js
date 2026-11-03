import test, { before, after, beforeEach } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "./server.js";

const TOKEN = "test-token-0123456789abcdef0123456789abcdef";
const READ_TOKEN = "read-token-0123456789abcdef0123456789abcdef";
const RUNNER_TOKEN = "runner-token-0123456789abcdef0123456789abcdef";
const ROLE_TOKENS = Object.fromEntries(["debugger", "coder", "tester", "governance"].map((role) => [role, `role-${role}-token-0123456789abcdef`]));
let server;
let base;
let state;

async function start(token = TOKEN, roleTokens = ROLE_TOKENS, readToken = READ_TOKEN, runnerToken = RUNNER_TOKEN) {
  const instance = createServer({ token, readToken, runnerToken, roleTokens, tenant: "test-tenant" });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return { instance, base: `http://127.0.0.1:${instance.address().port}` };
}
async function stop(instance) {
  if (instance?.listening) await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
}
async function request(path, { method = "GET", body, token, contentType = "application/json" } = {}) {
  const headers = {};
  let credential = token;
  if (credential === undefined) {
    if (path.startsWith("/api/events")) credential = ROLE_TOKENS[body?.role];
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
async function event(role, payload) {
  return request("/api/events", { method: "POST", body: { ...payload, role }, token: ROLE_TOKENS[role] });
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
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const stored = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
  assert.equal(stored.events.filter((item) => item.role === "debugger").length, 1);
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
  const duplicate = await request("/api/events", { method: "POST", body: { jobId: job.id, role: "debugger", status: "passed" } });
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

test("stub worker reports failure instead of falsely passing unexecuted work", async () => {
  const job = await createJob("prove worker executor is absent");
  const workerPath = fileURLToPath(new URL("../worker/worker.js", import.meta.url));
  const child = spawn(process.execPath, [workerPath], {
    env: { ...process.env, ROLE: "debugger", COORDINATOR_URL: base, SWARM_READ_TOKEN: READ_TOKEN, SWARM_ROLE_TOKEN: ROLE_TOKENS.debugger },
    stdio: "ignore",
  });
  try {
    let current;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      current = (await request("/api/jobs")).body.jobs.find((item) => item.id === job.id);
      if (current?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(current?.status, "failed");
    assert.match(current.events[0].note, /no task was executed/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
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
  assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: job.id, runner: "worker-b", ok: true } })).status, 403);
  assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: job.id, runner: "worker-a", ok: "yes" } })).status, 400);
  assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: job.id, runner: "worker-a", ok: true, note: "done" } })).status, 200);
  assert.equal((await request("/api/runner/complete", { method: "POST", body: { id: job.id, runner: "worker-a", ok: true } })).status, 409);
});

test("search is authenticated and query length is bounded", async () => {
  assert.equal((await request("/api/search?q=xy", { token: null })).status, 401);
  assert.equal((await request(`/api/search?q=${"x".repeat(81)}`)).status, 400);
  assert.equal((await request("/api/search?q=job")).status, 200);
});
