import test from "node:test";
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
