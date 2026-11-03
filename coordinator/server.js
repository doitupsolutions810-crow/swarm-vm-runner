import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "./redis-lite.js";

const PORT = Number(process.env.PORT || 4100);
const TENANT = process.env.SWARM_TENANT || "control12";
const ROLES = Object.freeze(["debugger", "coder", "tester", "governance"]);
const RUNNER_KINDS = new Set(["prove-success", "health-probe", "inventory", "search", "spawn-subagent"]);
const MAX_BODY = 16 * 1024;
const MAX_OBJECTIVE = 2000;

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.resume();
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    const error = new Error("application/json required");
    error.status = 415;
    throw error;
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch {
    const error = new Error("invalid json");
    error.status = 400;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("json object required");
    error.status = 400;
    throw error;
  }
  return value;
}

function tokenMatches(expected, supplied) {
  if (typeof expected !== "string" || expected.length < 32) return false;
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req, token) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer ([A-Za-z0-9._~+\/-]{32,512})$/.exec(header);
  return Boolean(match && tokenMatches(token, match[1]));
}

function validObjective(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_OBJECTIVE;
}

export function createServer({ token = process.env.SWARM_API_TOKEN, tenant = TENANT, redis = createClient(process.env.REDIS_URL || "redis://redis:6379") } = {}) {
  const jobs = new Map();
  const runnerJobs = new Map();
  const runnerQueue = [];
  let seq = 1;
  let runSeq = 1;

  async function createSwarmJob(objective) {
    const id = `job-${seq++}`;
    const job = { id, tenant, objective: objective.trim(), status: "queued", chain: [...ROLES], step: 0, createdAt: new Date().toISOString(), events: [] };
    jobs.set(id, job);
    await redis.lpush(`swarm:${tenant}:debugger`, id);
    return job;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, tenant, jobs: jobs.size, runnerJobs: runnerJobs.size, runnerQueued: runnerQueue.length, roles: ROLES, redis: redis.ok });
      }
      if (url.pathname.startsWith("/api/")) {
        if (typeof token !== "string" || token.length < 32) return json(res, 503, { error: "coordinator authentication is not configured" });
        if (!authorized(req, token)) return json(res, 401, { error: "unauthorized" });
      }
      if (req.method === "GET" && url.pathname === "/api/jobs") return json(res, 200, { jobs: [...jobs.values()] });
      if (req.method === "POST" && url.pathname === "/api/jobs") {
        const payload = await readJson(req);
        if (!validObjective(payload.objective)) return json(res, 400, { error: "objective required (1..2000 characters)" });
        return json(res, 202, await createSwarmJob(payload.objective));
      }
      if (req.method === "POST" && url.pathname === "/api/multi-agent-debug") {
        const payload = await readJson(req);
        if (!validObjective(payload.objective)) return json(res, 400, { error: "objective required (1..2000 characters)" });
        const job = await createSwarmJob(payload.objective);
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && job.status !== "completed" && job.status !== "failed") {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return json(res, job.status === "completed" ? 200 : 202, {
          success: job.status === "completed", status: job.status, jobId: job.id,
          agents: job.events.map((event) => event.role), events: job.events,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/events") {
        const payload = await readJson(req);
        const job = jobs.get(payload.jobId);
        if (!job) return json(res, 404, { error: "unknown job" });
        if (job.status === "completed" || job.status === "failed") return json(res, 409, { error: "job is terminal" });
        const expectedRole = job.chain[job.step];
        if (payload.role !== expectedRole) return json(res, 409, { error: "role is not next in chain", expectedRole });
        if (payload.status !== "passed" && payload.status !== "failed") return json(res, 400, { error: "status must be passed or failed" });
        if (job.events.some((event) => event.role === payload.role)) return json(res, 409, { error: "role already reported" });
        const note = typeof payload.note === "string" ? payload.note.slice(0, 500) : "";
        job.events.push({ role: payload.role, status: payload.status, note, at: new Date().toISOString() });
        if (payload.status === "failed") job.status = "failed";
        else if (job.step < ROLES.length - 1) {
          job.step += 1;
          job.status = "running";
          await redis.lpush(`swarm:${tenant}:${ROLES[job.step]}`, job.id);
        } else job.status = "completed";
        return json(res, 200, job);
      }
      if (req.method === "GET" && url.pathname === "/api/runner/jobs") return json(res, 200, { jobs: [...runnerJobs.values()] });
      if (req.method === "POST" && url.pathname === "/api/runner/jobs") {
        const payload = await readJson(req);
        const kind = typeof payload.kind === "string" ? payload.kind : "prove-success";
        if (!RUNNER_KINDS.has(kind)) return json(res, 400, { error: "runner kind not allowlisted" });
        const objective = payload.objective ?? payload.query ?? "";
        if (typeof objective !== "string" || objective.length > MAX_OBJECTIVE) return json(res, 400, { error: "invalid objective" });
        const id = `run-${runSeq++}`;
        const job = { id, kind, query: String(payload.query || "").slice(0, 80), objective: objective.slice(0, MAX_OBJECTIVE), status: "queued", createdAt: new Date().toISOString() };
        runnerJobs.set(id, job);
        runnerQueue.push(id);
        return json(res, 202, job);
      }
      if (req.method === "POST" && url.pathname === "/api/runner/claim") {
        const payload = await readJson(req);
        if (typeof payload.runner !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(payload.runner)) return json(res, 400, { error: "valid runner name required" });
        const id = runnerQueue.shift();
        if (!id) { res.writeHead(204); return res.end(); }
        const job = runnerJobs.get(id);
        if (!job || job.status !== "queued") return json(res, 409, { error: "queue state inconsistent" });
        job.status = "running";
        job.runner = payload.runner;
        job.claimedAt = new Date().toISOString();
        return json(res, 200, job);
      }
      if (req.method === "POST" && url.pathname === "/api/runner/complete") {
        const payload = await readJson(req);
        const job = runnerJobs.get(payload.id);
        if (!job) return json(res, 404, { error: "unknown runner job" });
        if (job.status !== "running") return json(res, 409, { error: "runner job is not active" });
        if (payload.runner !== job.runner) return json(res, 403, { error: "runner does not own job" });
        if (typeof payload.ok !== "boolean") return json(res, 400, { error: "ok boolean required" });
        job.status = payload.ok ? "completed" : "failed";
        job.note = typeof payload.note === "string" ? payload.note.slice(0, 500) : "";
        if (Array.isArray(payload.hits)) job.hits = payload.hits.slice(0, 20);
        if (payload.spawned && typeof payload.spawned === "object" && !Array.isArray(payload.spawned)) job.spawned = payload.spawned;
        job.completedAt = new Date().toISOString();
        return json(res, 200, job);
      }
      if (req.method === "GET" && url.pathname === "/api/search") {
        const q = (url.searchParams.get("q") || "").toLowerCase();
        if (q.length < 2 || q.length > 80) return json(res, 400, { error: "q must be 2..80 chars" });
        const hits = [];
        for (const job of jobs.values()) if (`${job.id} ${job.objective} ${job.status}`.toLowerCase().includes(q)) hits.push({ type: "swarm", id: job.id, status: job.status, objective: job.objective });
        for (const job of runnerJobs.values()) if (`${job.id} ${job.kind} ${job.query || ""} ${job.note || ""}`.toLowerCase().includes(q)) hits.push({ type: "runner", id: job.id, kind: job.kind, status: job.status });
        return json(res, 200, { q, hits: hits.slice(0, 20) });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, Number.isInteger(error.status) ? error.status : 400, { error: error.status ? error.message : "invalid request" });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 12000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen(PORT, () => console.log(`coordinator listening on ${PORT} tenant=${TENANT}`));
}
