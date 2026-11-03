import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED = new Set(["prove-success", "health-probe", "inventory", "search", "spawn-subagent"]);

export function boundedInteger(value, fallback, min, max, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(name + " must be an integer in " + min + ".." + max);
  }
  return parsed;
}

export function validateRunnerConfig(env = process.env) {
  const leaseMs = boundedInteger(env.RUNNER_LEASE_MS, 30000, 5000, 120000, "RUNNER_LEASE_MS");
  const heartbeatMs = boundedInteger(env.RUNNER_HEARTBEAT_MS, 10000, 250, 60000, "RUNNER_HEARTBEAT_MS");
  const pollMs = boundedInteger(env.POLL_MS, 3000, 250, 60000, "POLL_MS");
  if (heartbeatMs >= Math.floor(leaseMs / 2)) {
    throw new RangeError("RUNNER_HEARTBEAT_MS must be less than half RUNNER_LEASE_MS");
  }
  return { leaseMs, heartbeatMs, pollMs };
}

function safeQuery(raw) {
  const q = String(raw || "").trim().slice(0, 80);
  return /^[a-zA-Z0-9._/ -]{2,80}$/.test(q) ? q : null;
}

function delay(ms, signal, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeoutImpl(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (signal?.aborted) return finish();
    timer = setTimeoutImpl(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function validateCoordinatorUrl(raw) {
  const parsed = new URL(String(raw || "http://127.0.0.1:4100"));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
    throw new TypeError("COORDINATOR_URL must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\\/+$/, "");
}

export function walkHits(dir, needle, acc = [], {
  fsImpl = fs, pathImpl = path, root = dir, signal, depth = 0, maxDepth = 6, maxHits = 20,
} = {}) {
  if (signal?.aborted || acc.length >= maxHits || depth > maxDepth) return acc;
  let entries = [];
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (signal?.aborted || acc.length >= maxHits) break;
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name.startsWith(".")) continue;
    const full = pathImpl.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.toLowerCase().includes(needle.toLowerCase())) {
        acc.push({ type: "dir", path: pathImpl.relative(root, full) });
      }
      walkHits(full, needle, acc, {
        fsImpl, pathImpl, root, signal, depth: depth + 1, maxDepth, maxHits,
      });
    } else if (ent.isFile()) {
      const rel = pathImpl.relative(root, full);
      let hit = rel.toLowerCase().includes(needle.toLowerCase());
      if (!hit && /\\.(js|mjs|md|yml|json|sh|html|txt)$/i.test(ent.name)) {
        try {
          if (!signal?.aborted) hit = fsImpl.readFileSync(full, "utf8").toLowerCase().includes(needle.toLowerCase());
        } catch { hit = false; }
      }
      if (hit) acc.push({ type: "file", path: rel });
    }
  }
  return acc;
}

export function createInternalRunner({
  env = process.env,
  fetchImpl = fetch,
  fsImpl = fs,
  pathImpl = path,
  logger = console,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const { leaseMs, heartbeatMs, pollMs } = validateRunnerConfig(env);
  const COORDINATOR = validateCoordinatorUrl(env.COORDINATOR_URL);
  const NAME = env.INTERNAL_RUNNER_NAME || "control12-internal-1";
  const ROOT = pathImpl.resolve(env.SWARM_ROOT || ".");
  const API_TOKEN = env.SWARM_API_TOKEN || "";
  const READ_TOKEN = env.SWARM_READ_TOKEN || "";
  const RUNNER_TOKEN = env.SWARM_RUNNER_TOKEN || "";
  for (const [name, value] of Object.entries({
    SWARM_API_TOKEN: API_TOKEN,
    SWARM_READ_TOKEN: READ_TOKEN,
    SWARM_RUNNER_TOKEN: RUNNER_TOKEN,
  })) {
    if (typeof value !== "string" || value.length < 32) {
      throw new Error(name + " must be at least 32 characters");
    }
  }

  let tickRunning = false;
  let interval = null;
  let activeTaskController = null;
  let activeHeartbeatController = null;

  async function request(url, options = {}, timeoutMs = 5000) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    return fetchImpl(url, { ...options, signal });
  }

  async function claim() {
    const res = await request(COORDINATOR + "/api/runner/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + RUNNER_TOKEN,
      },
      body: JSON.stringify({ runner: NAME, leaseMs }),
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error("claim " + res.status);
    const job = await res.json();
    if (!job || typeof job.id !== "string" || !/^run-[A-Za-z0-9_.:-]{1,128}$/.test(job.id)
        || job.runner !== NAME
        || typeof job.claimToken !== "string" || job.claimToken.length < 32 || job.claimToken.length > 512
        || !Number.isFinite(job.leaseExpiresAt) || job.leaseExpiresAt <= now()) {
      throw new Error("coordinator returned an invalid runner claim");
    }
    return job;
  }

  async function renew(job, signal) {
    const res = await request(COORDINATOR + "/api/runner/renew", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + RUNNER_TOKEN,
      },
      body: JSON.stringify({
        id: job.id,
        runner: NAME,
        claimToken: job.claimToken,
        leaseMs,
      }),
      signal,
    });
    if (!res.ok) throw new Error("runner lease renewal rejected (" + res.status + ")");
    const body = await res.json();
    if (body?.id !== job.id || body.runner !== NAME
        || !Number.isFinite(body.leaseExpiresAt) || body.leaseExpiresAt <= now()) {
      throw new Error("coordinator returned an invalid renewed lease");
    }
    job.leaseExpiresAt = body.leaseExpiresAt;
    return body.leaseExpiresAt;
  }

  async function complete(job, result) {
    const res = await request(COORDINATOR + "/api/runner/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + RUNNER_TOKEN,
      },
      body: JSON.stringify({
        id: job.id,
        runner: NAME,
        claimToken: job.claimToken,
        ...result,
      }),
    });
    if (!res.ok) throw new Error("complete " + res.status);
    return res.json();
  }

  async function search(job, signal) {
    const q = safeQuery(job.query || job.objective);
    if (!q) return { ok: false, note: "search query rejected" };
    const local = walkHits(ROOT, q, [], { fsImpl, pathImpl, root: ROOT, signal });
    if (signal.aborted) return { ok: false, note: "search cancelled after runner lease loss" };
    let remote = { hits: [] };
    try {
      const res = await request(COORDINATOR + "/api/search?q=" + encodeURIComponent(q), {
        headers: { authorization: "Bearer " + READ_TOKEN },
        signal,
      });
      if (res.ok) remote = await res.json();
    } catch (error) {
      if (signal.aborted) return { ok: false, note: "search cancelled after runner lease loss" };
      logger.warn(NAME, "remote search unavailable:", error.message);
    }
    if (signal.aborted) return { ok: false, note: "search cancelled after runner lease loss" };
    return {
      ok: true,
      note: NAME + " search q=" + q + " hits=" + (local.length + (remote.hits || []).length),
      hits: [...local, ...(remote.hits || [])].slice(0, 20),
    };
  }

  async function spawnSubagent(job, signal) {
    const objective = String(job.objective || job.query || "spawned by internal runner").slice(0, 2000);
    // Stable across a coordinator timeout, process restart, and claim replay.
    const idempotencyKey = "spawn:" + job.id;
    const res = await request(COORDINATOR + "/api/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + API_TOKEN,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ objective }),
      signal,
    });
    if (![200, 202].includes(res.status)) return { ok: false, note: "spawn failed " + res.status };
    const spawned = await res.json();
    return {
      ok: true,
      note: NAME + " spawned " + spawned.id + " chain=" + (spawned.chain || []).join(">"),
      spawned,
      idempotentReplay: spawned.idempotent_replay === true,
    };
  }

  async function runAllowlisted(job, signal) {
    if (signal.aborted) return { ok: false, note: "runner task cancelled" };
    const kind = job.kind || "prove-success";
    if (!ALLOWED.has(kind)) return { ok: false, note: "rejected unlisted kind:" + kind };
    if (kind === "health-probe") return { ok: true, note: NAME + " health-probe " + process.platform + " " + process.arch };
    if (kind === "inventory") return { ok: true, note: NAME + " cwd=" + process.cwd() + " pid=" + process.pid };
    if (kind === "search") return search(job, signal);
    if (kind === "spawn-subagent") return spawnSubagent(job, signal);
    return { ok: false, note: "no verifiable proof adapter is configured; refusing to report success" };
  }

  function startHeartbeat(job, taskController) {
    const heartbeatController = new AbortController();
    let leaseLost = false;
    const promise = (async () => {
      while (!heartbeatController.signal.aborted) {
        await delay(heartbeatMs, heartbeatController.signal, setTimeoutImpl, clearTimeoutImpl);
        if (heartbeatController.signal.aborted) return;
        try {
          await renew(job, heartbeatController.signal);
        } catch (error) {
          if (heartbeatController.signal.aborted) return;
          leaseLost = true;
          const reason = new Error("runner lease lost: " + error.message);
          taskController.abort(reason);
          logger.error(NAME, job.id, reason.message);
          return;
        }
      }
    })();
    return {
      controller: heartbeatController,
      signal: heartbeatController.signal,
      promise,
      stop: () => heartbeatController.abort(),
      leaseLost: () => leaseLost,
    };
  }

  async function tick() {
    if (tickRunning) return { skipped: true, reason: "runner tick already active" };
    tickRunning = true;
    try {
      const job = await claim();
      if (!job) return null;

      const taskController = new AbortController();
      activeTaskController = taskController;
      const heartbeat = startHeartbeat(job, taskController);
      activeHeartbeatController = heartbeat.controller;

      let result;
      try {
        result = await runAllowlisted(job, taskController.signal);
      } catch (error) {
        result = { ok: false, note: "runner task failed: " + (error?.message || String(error)) };
      } finally {
        heartbeat.stop();
        await heartbeat.promise;
      }

      if (heartbeat.leaseLost()) {
        logger.warn(NAME, job.id, "task result discarded because the runner lease was lost");
        return { leaseLost: true, completed: false };
      }
      if (taskController.signal.aborted) {
        result = { ok: false, note: "runner task cancelled before completion" };
      }
      const completed = await complete(job, result || { ok: false, note: "runner produced no result" });
      logger.log(NAME, job.id, result?.ok ? "ok" : "deny", result?.note || "");
      return completed;
    } finally {
      activeTaskController = null;
      activeHeartbeatController = null;
      tickRunning = false;
    }
  }

  function start() {
    if (interval !== null) return;
    logger.log("internal runner " + NAME + " polling " + COORDINATOR + " allow=" + [...ALLOWED].join(","));
    interval = setIntervalImpl(() => {
      tick().catch(error => logger.error(NAME, error.message));
    }, pollMs);
    tick().catch(error => logger.error(NAME, error.message));
  }

  function stop() {
    if (interval !== null) {
      clearIntervalImpl(interval);
      interval = null;
    }
    activeTaskController?.abort(new Error("runner stopping"));
    activeHeartbeatController?.abort();
  }

  return {
    tick,
    start,
    stop,
    claim,
    renew,
    complete,
    runAllowlisted,
    config: { leaseMs, heartbeatMs, pollMs, coordinatorUrl: COORDINATOR, runnerName: NAME },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createInternalRunner().start();
}
