import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { executeRoleTask } from "./execute.js";
const tokens = { readToken: "r".repeat(40), roleToken: "o".repeat(40), executorToken: "e".repeat(40) };
const job = { id: "job-1", objective: "run tests" };
const good = { evidence: { job_id: "job-1", role: "tester", status: "succeeded", report: { tests: [{ command: "npm test", exit_code: 0 }] } }, evidence_signature: "signature" };

test("calls Grok Bot and forwards signed evidence to coordinator", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return calls.length === 1 ? { status: 200, json: async () => good } : { ok: true, status: 200 };
  };
  const out = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok/api/swarm/execute", ...tokens, fetchImpl });
  assert.equal(out.reported, true);
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].opts.body);
  assert.equal(body.status, "passed");
  assert.equal(body.evidence_signature, "signature");
});

test("executor outage leaves job pending and never fabricates a failure event", async () => {
  let calls = 0;
  const out = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl: async () => { calls += 1; return { status: 503, json: async () => ({ error: "not ready" }) }; } });
  assert.equal(out.pending, true);
  assert.equal(calls, 1);
});

test("mismatched job, role or unsigned response never reaches coordinator", async () => {
  let calls = 0;
  const out = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl: async () => { calls += 1; return { status: 200, json: async () => ({ ...good, evidence: { ...good.evidence, job_id: "job-evil" } }) }; } });
  assert.equal(out.pending, true);
  assert.equal(calls, 1);
});

test("signed failure evidence is reported as failed, never passed", async () => {
  const calls = [];
  const failed = { evidence: { ...good.evidence, status: "failed", report: {} }, evidence_signature: "signature" };
  const out = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl: async (url, opts) => { calls.push({ url, opts }); return calls.length === 1 ? { status: 422, json: async () => failed } : { ok: true, status: 200 }; } });
  assert.equal(out.status, "failed");
  assert.equal(JSON.parse(calls[1].opts.body).status, "failed");
});

test("worker image includes the imported execution module", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY worker\.js \.\//);
  assert.match(dockerfile, /COPY execute\.js \.\//);
});

test("executor and coordinator requests have finite abort deadlines", async () => {
  const signals = [];
  const fetchImpl = async (_url, opts) => {
    signals.push(opts.signal);
    return signals.length === 1 ? { status: 200, json: async () => good } : { ok: true, status: 200 };
  };
  const out = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl });
  assert.equal(out.reported, true);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal instanceof AbortSignal));
  assert.ok(signals.every(signal => signal.aborted === false));
});

test("non-JSON executor responses remain pending", async () => {
  let calls = 0;
  const out = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl: async () => {
    calls += 1;
    return { status: 200, json: async () => { throw new SyntaxError("invalid json"); } };
  } });
  assert.equal(out.pending, true);
  assert.equal(calls, 1);
});

test("HTTP status and signed evidence outcome must agree", async () => {
  let calls = 0;
  const failed = { evidence: { ...good.evidence, status: "failed" }, evidence_signature: "signature" };
  const out = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl: async () => {
    calls += 1;
    return { status: 200, json: async () => failed };
  } });
  assert.equal(out.pending, true);
  assert.equal(calls, 1);
});

test("coordinator rejection and ambiguous transport never mark the event reported", async () => {
  let calls = 0;
  const rejected = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? { status: 200, json: async () => good } : { ok: false, status: 403 };
  } });
  assert.equal(rejected.reported, false);
  assert.equal(rejected.pending, true);
  calls = 0;
  const unknown = await executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return { status: 200, json: async () => good };
    throw new Error("connection reset after send");
  } });
  assert.equal(unknown.reported, false);
  assert.equal(unknown.pending, true);
});

test("retries after an ambiguous coordinator report reuse the same executor evidence", async () => {
  const submitted = [];
  let cycle = 0;
  const fetchImpl = async (_url, opts) => {
    if (opts.headers.authorization === "Bearer " + tokens.executorToken) {
      return { status: 200, json: async () => good };
    }
    submitted.push(JSON.parse(opts.body));
    cycle += 1;
    if (cycle === 1) throw new Error("response lost");
    return { ok: true, status: 200 };
  };
  const args = { job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", ...tokens, fetchImpl };
  const first = await executeRoleTask(args);
  const second = await executeRoleTask(args);
  assert.equal(first.pending, true);
  assert.equal(second.reported, true);
  assert.deepEqual(submitted[0].evidence, submitted[1].evidence);
  assert.equal(submitted[0].evidence_signature, submitted[1].evidence_signature);
});

test("short credentials are rejected before any network call", async () => {
  let calls = 0;
  await assert.rejects(() => executeRoleTask({ job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok", readToken: "short", roleToken: tokens.roleToken, executorToken: tokens.executorToken, fetchImpl: async () => { calls += 1; } }), /at least 32 characters/);
  assert.equal(calls, 0);
});


test("uses configured executor and coordinator timeout values", async () => {
  const originalTimeout = AbortSignal.timeout;
  const observed = [];
  const calls = [];
  try {
    AbortSignal.timeout = (milliseconds) => {
      observed.push(milliseconds);
      return originalTimeout(60_000);
    };
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return calls.length === 1 ? { status: 200, json: async () => good } : { ok: true, status: 200 };
    };
    const out = await executeRoleTask({
      job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok",
      ...tokens, fetchImpl, executorTimeoutMs: 47_000, coordinatorTimeoutMs: 8_500,
    });
    assert.equal(out.reported, true);
    assert.deepEqual(observed, [47_000, 8_500]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("rejects invalid or unsafe timeout values before making network calls", async () => {
  const invalid = [0, -1, 1.5, NaN, Infinity, "1000", 2_147_483_648, null];
  for (const value of invalid) {
    let calls = 0;
    await assert.rejects(
      () => executeRoleTask({
        job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok",
        ...tokens, fetchImpl: async () => { calls += 1; },
        executorTimeoutMs: value,
      }),
      /executorTimeoutMs must be an integer/,
    );
    assert.equal(calls, 0, "invalid timeout must fail before network I/O");
  }
  let calls = 0;
  await assert.rejects(
    () => executeRoleTask({
      job, role: "tester", coordinatorUrl: "http://coord", executorUrl: "http://grok",
      ...tokens, fetchImpl: async () => { calls += 1; },
      coordinatorTimeoutMs: 0,
    }),
    /coordinatorTimeoutMs must be an integer/,
  );
  assert.equal(calls, 0);
});
