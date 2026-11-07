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

test("runner rejects unsafe coordinator URLs and normalizes a valid base path", () => {
  for (const url of [
    "ftp://coordinator:4100",
    "https://user:password@coordinator:4100",
    "https://coordinator:4100?token=secret",
    "https://coordinator:4100/#fragment",
    "not a URL",
  ]) {
    assert.throws(
      () => createInternalRunner({ env: env({ COORDINATOR_URL: url }), fetchImpl: async () => jsonResponse(204, {}) }),
      /COORDINATOR_URL/,
      url,
    );
  }
  const runner = createInternalRunner({
    env: env({ COORDINATOR_URL: "https://coordinator.example/base///" }),
    fetchImpl: async () => jsonResponse(204, {}),
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(runner.config.coordinatorUrl, "https://coordinator.example/base");
  runner.stop();
});

test("claim rejects malformed job identity, runner identity, token, and lease expiry", async () => {
  const invalidClaims = [
    { ...claimedJob(), id: "../escape" },
    { ...claimedJob(), runner: "another-runner" },
    { ...claimedJob(), claimToken: "short" },
    { ...claimedJob(), leaseExpiresAt: NaN },
    { ...claimedJob(), leaseExpiresAt: Date.now() - 1 },
  ];
  for (const invalid of invalidClaims) {
    const runner = createInternalRunner({
      env: env(),
      fetchImpl: async () => jsonResponse(200, invalid),
      logger: { log() {}, warn() {}, error() {} },
    });
    await assert.rejects(() => runner.claim(), /invalid runner claim/);
    runner.stop();
  }
  const emptyRunner = createInternalRunner({
    env: env(),
    fetchImpl: async () => new Response(null, { status: 204 }),
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(await emptyRunner.claim(), null);
  emptyRunner.stop();
});

test("renew rejects wrong server identity, stale expiry, and non-success responses", async () => {
  const job = claimedJob();
  for (const body of [
    { id: "run-other", runner: RUNNER_NAME, leaseExpiresAt: Date.now() + 10000 },
    { id: job.id, runner: "another-runner", leaseExpiresAt: Date.now() + 10000 },
    { id: job.id, runner: RUNNER_NAME, leaseExpiresAt: Date.now() - 1 },
  ]) {
    const runner = createInternalRunner({
      env: env(),
      fetchImpl: async () => jsonResponse(200, body),
      logger: { log() {}, warn() {}, error() {} },
    });
    await assert.rejects(() => runner.renew(job), /invalid renewed lease/);
    runner.stop();
  }
  const failed = createInternalRunner({
    env: env(),
    fetchImpl: async () => jsonResponse(409, { error: "expired" }),
    logger: { log() {}, warn() {}, error() {} },
  });
  await assert.rejects(() => failed.renew(job), /renewal rejected/);
  failed.stop();
});

test("runner renews long-running work and a single process never overlaps ticks", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-internal-runner-heartbeat-"));
  fs.writeFileSync(path.join(root, "needle.txt"), "needle");
  let claimCount = 0;
  let renewalCount = 0;
  let completionCount = 0;
  let releaseSearch;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/runner/claim") {
      claimCount += 1;
      return jsonResponse(200, claimedJob("search"));
    }
    if (parsed.pathname === "/api/runner/renew") {
      renewalCount += 1;
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
  await waitFor(() => renewalCount >= 1);
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

test("ambiguous child creation keeps parent retryable and reconciles the same idempotency key", async () => {
  const spawnKeys = [];
  const children = new Map();
  let completionCount = 0;
  let claimCount = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/runner/claim") {
      claimCount += 1;
      return jsonResponse(200, claimedJob("spawn-subagent"));
    }
    if (parsed.pathname === "/api/jobs") {
      const key = options.headers["idempotency-key"];
      spawnKeys.push(key);
      if (!children.has(key)) {
        children.set(key, { id: "job-901", chain: ["debugger", "coder", "tester", "governance"] });
        // Simulate: coordinator committed the child, but the response was lost.
        throw new Error("socket reset after coordinator commit");
      }
      return jsonResponse(200, { ...children.get(key), idempotent_replay: true });
    }
    if (parsed.pathname === "/api/runner/complete") {
      completionCount += 1;
      return jsonResponse(200, { id: "run-123", status: "completed" });
    }
    throw new Error("unexpected runner request: " + parsed.pathname);
  };
  const runner = createInternalRunner({ env: env(), fetchImpl, logger: { log() {}, warn() {}, error() {} } });
  try {
    const first = await runner.tick();
    assert.equal(first.retryable, true);
    assert.equal(first.completed, false);
    assert.equal(completionCount, 0);
    assert.equal(children.size, 1);

    const second = await runner.tick();
    assert.equal(second.status, "completed");
    assert.equal(claimCount, 2);
    assert.equal(spawnKeys.length, 2);
    assert.equal(spawnKeys[0], "spawn:run-123");
    assert.equal(spawnKeys[1], spawnKeys[0]);
    assert.equal(children.size, 1);
    assert.equal(completionCount, 1);
  } finally {
    runner.stop();
  }
});

test("shutdown during a pending claim cannot start work after claim resolves", async () => {
  let resolveClaim;
  let claimStarted = false;
  let claimSignal;
  let executionCalls = 0;
  let completionCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/runner/claim") {
      claimStarted = true;
      claimSignal = options.signal;
      return new Promise(resolve => {
        resolveClaim = () => resolve(jsonResponse(200, claimedJob("inventory")));
      });
    }
    if (parsed.pathname === "/api/runner/complete") {
      completionCalls += 1;
      return jsonResponse(200, { status: "completed" });
    }
    executionCalls += 1;
    throw new Error("unexpected post-claim request: " + parsed.pathname);
  };
  const runner = createInternalRunner({ env: env(), fetchImpl, logger: { log() {}, warn() {}, error() {} } });

  const pending = runner.tick();
  await waitFor(() => claimStarted && typeof resolveClaim === "function");
  runner.stop();
  assert.equal(claimSignal.aborted, true);
  resolveClaim();

  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(executionCalls, 0);
  assert.equal(completionCalls, 0);
  assert.equal((await runner.tick()).stopped, true);
});

test("workspace search skips credentials, private keys, hidden files, and oversized files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-internal-runner-secret-filter-"));
  try {
    fs.writeFileSync(path.join(root, "visible.txt"), "the needle is visible");
    fs.writeFileSync(path.join(root, "secret.txt"), "the needle is secret");
    fs.writeFileSync(path.join(root, "grok-private.pem"), "the needle is private");
    fs.writeFileSync(path.join(root, ".hidden.txt"), "the needle is hidden");
    fs.mkdirSync(path.join(root, "secrets"));
    fs.mkdirSync(path.join(root, "credentials"));
    fs.writeFileSync(path.join(root, "secrets", "token.txt"), "the needle is in secrets");
    fs.writeFileSync(path.join(root, "credentials", "cloud.json"), "the needle is in credentials");
    fs.writeFileSync(path.join(root, "oversized.txt"), "needle".repeat(100));

    const hits = walkHits(root, "needle", [], { root, maxFiles: 100, maxFileBytes: 64 });
    assert.deepEqual(hits, [{ type: "file", path: "visible.txt" }]);

    const limited = walkHits(root, "needle", [], { root, maxFiles: 1, maxFileBytes: 64 });
    assert.ok(limited.length <= 1);
    assert.ok(limited.every(hit => hit.path === "visible.txt"));
    assert.throws(() => walkHits(root, "needle", [], { root, maxFiles: 0 }), /positive safe integers/);
    assert.throws(() => walkHits(root, "needle", [], { root, maxFileBytes: -1 }), /positive safe integers/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
