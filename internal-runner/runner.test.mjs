import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInternalRunner, validateRunnerConfig, walkHits } from "./runner.mjs";

const TOKEN = "runner-test-token-" + "r".repeat(40);
const READ_TOKEN = "reader-test-token-" + "d".repeat(40);
const API_TOKEN = "api-test-token-" + "a".repeat(40);
const RUNNER_NAME = "runner-test-1";
const CLAIM_TOKEN = "claim-token-" + "c".repeat(40);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function env(overrides = {}) {
  return {
    COORDINATOR_URL: "http://coordinator:4100",
    INTERNAL_RUNNER_NAME: RUNNER_NAME,
    SWARM_API_TOKEN: API_TOKEN,
    SWARM_READ_TOKEN: READ_TOKEN,
    SWARM_RUNNER_TOKEN: TOKEN,
    RUNNER_LEASE_MS: "5000",
    RUNNER_HEARTBEAT_MS: "250",
    POLL_MS: "3000",
    ...overrides,
  };
}

function claimedJob(kind = "inventory") {
  return {
    id: "run-123",
    kind,
    query: "needle",
    objective: "needle",
    status: "running",
    runner: RUNNER_NAME,
    claimToken: CLAIM_TOKEN,
    leaseExpiresAt: Date.now() + 5000,
  };
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("condition not reached before timeout");
}

test("runner lease configuration rejects unsafe heartbeat and lease values", () => {
  assert.deepEqual(validateRunnerConfig(env()), { leaseMs: 5000, heartbeatMs: 250, pollMs: 3000 });
  assert.throws(() => validateRunnerConfig(env({ RUNNER_LEASE_MS: "4999" })), /RUNNER_LEASE_MS/);
  assert.throws(() => validateRunnerConfig(env({ RUNNER_LEASE_MS: "120001" })), /RUNNER_LEASE_MS/);
  assert.throws(() => validateRunnerConfig(env({ RUNNER_HEARTBEAT_MS: "2500" })), /less than half/);
  assert.throws(() => validateRunnerConfig(env({ RUNNER_HEARTBEAT_MS: "NaN" })), /RUNNER_HEARTBEAT_MS/);
  assert.throws(() => validateRunnerConfig(env({ POLL_MS: "1.5" })), /POLL_MS/);
});

test("runner renews long-running work and a single process never overlaps ticks", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-internal-runner-heartbeat-"));
  fs.writeFileSync(path.join(root, "needle.txt"), "needle");
  let claimCount = 0;
  let renewalCount = 0;
  let completionCount = 0;
  let releaseSearch;
  let renewalObserved;
  const renewed = new Promise(resolve => { renewalObserved = resolve; });
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/runner/claim") {
      claimCount += 1;
      return jsonResponse(200, claimedJob("search"));
    }
    if (parsed.pathname === "/api/runner/renew") {
      renewalCount += 1;
      renewalObserved();
      return jsonResponse(200, {
        id: "run-123", runner: RUNNER_NAME, leaseExpiresAt: Date.now() + 5000,
      });
    }
    if (parsed.pathname === "/api/search") {
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          reject(new Error("search aborted"));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        releaseSearch = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(jsonResponse(200, { hits: [] }));
        };
      });
    }
    if (parsed.pathname === "/api/runner/complete") {
      completionCount += 1;
      return jsonResponse(200, { id: "run-123", status: "completed" });
    }
    throw new Error("unexpected runner request: " + parsed.pathname);
  };
  const runner = createInternalRunner({ env: env({ SWARM_ROOT: root }), fetchImpl, logger: { log() {}, warn() {}, error() {} } });
  t.after(() => {
    runner.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const running = runner.tick();
  await renewed;
  const overlapping = await runner.tick();
  assert.equal(overlapping.skipped, true);
  assert.equal(claimCount, 1);
  assert.ok(renewalCount >= 1);
  assert.equal(typeof releaseSearch, "function");
  releaseSearch();
  const result = await running;
  assert.equal(completionCount, 1);
  assert.equal(result.status, "completed");
});

test("runner aborts work and never completes a job after lease renewal fails", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-internal-runner-lease-loss-"));
  fs.writeFileSync(path.join(root, "needle.txt"), "needle");
  let completionCount = 0;
  let searchAborted = false;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/runner/claim") return jsonResponse(200, claimedJob("search"));
    if (parsed.pathname === "/api/runner/renew") return jsonResponse(409, { error: "runner claim expired" });
    if (parsed.pathname === "/api/search") {
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => {
          searchAborted = true;
          signal?.removeEventListener("abort", onAbort);
          reject(new Error("search aborted"));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (parsed.pathname === "/api/runner/complete") {
      completionCount += 1;
      return jsonResponse(200, { status: "completed" });
    }
    throw new Error("unexpected runner request: " + parsed.pathname);
  };
  const runner = createInternalRunner({ env: env({ SWARM_ROOT: root }), fetchImpl, logger: { log() {}, warn() {}, error() {} } });
  t.after(() => {
    runner.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runner.tick();
  assert.equal(result.leaseLost, true);
  assert.equal(searchAborted, true);
  assert.equal(completionCount, 0);
});

test("spawn-subagent retries reuse one stable idempotency key after an ambiguous completion", async () => {
  let claimCount = 0;
  let completionCount = 0;
  const spawnKeys = [];
  const createdByKey = new Map();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/runner/claim") {
      claimCount += 1;
      return jsonResponse(200, claimedJob("spawn-subagent"));
    }
    if (parsed.pathname === "/api/jobs") {
      const key = options.headers["idempotency-key"];
      spawnKeys.push(key);
      let spawned = createdByKey.get(key);
      if (!spawned) {
        spawned = { id: "job-900", chain: ["debugger", "coder", "tester", "governance"] };
        createdByKey.set(key, spawned);
      }
      return jsonResponse(createdByKey.size === 1 && spawnKeys.length === 1 ? 202 : 200, {
        ...spawned, idempotent_replay: spawnKeys.length > 1,
      });
    }
    if (parsed.pathname === "/api/runner/complete") {
      completionCount += 1;
      if (completionCount === 1) return jsonResponse(503, { error: "response lost" });
      return jsonResponse(200, { id: "run-123", status: "completed" });
    }
    throw new Error("unexpected runner request: " + parsed.pathname);
  };
  const runner = createInternalRunner({ env: env(), fetchImpl, logger: { log() {}, warn() {}, error() {} } });
  try {
    await assert.rejects(() => runner.tick(), /complete 503/);
    const result = await runner.tick();
    assert.equal(result.status, "completed");
    assert.equal(claimCount, 2);
    assert.equal(spawnKeys.length, 2);
    assert.equal(spawnKeys[0], "spawn:run-123");
    assert.equal(spawnKeys[1], spawnKeys[0]);
    assert.equal(createdByKey.size, 1);
  } finally {
    runner.stop();
  }
});

test("workspace search walk exits promptly when its lease signal is already aborted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-internal-runner-abort-walk-"));
  try {
    fs.writeFileSync(path.join(root, "needle.txt"), "needle");
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(walkHits(root, "needle", [], { root, signal: controller.signal }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
