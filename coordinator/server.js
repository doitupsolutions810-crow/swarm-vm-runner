import http from "node:http";
import { createClient } from "./redis-lite.js";

const PORT = Number(process.env.PORT || 4100);
const TENANT = process.env.SWARM_TENANT || "control12";
const ROLES = ["debugger", "coder", "tester", "governance"];
const redis = createClient(process.env.REDIS_URL || "redis://redis:6379");
const jobs = new Map();
const runnerJobs = new Map();
const runnerQueue = [];
let seq = 1;
let runSeq = 1;

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}
function admit(objective) {
  if (!objective || typeof objective !== "string") return "objective required";
  if (objective.length > 2000) return "objective too long";
  return null;
}
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
async function createSwarmJob(objective) {
  const id = `job-${seq++}`;
  const job = { id, tenant: TENANT, objective, status: "queued", chain: ROLES, step: 0, createdAt: new Date().toISOString(), events: [] };
  jobs.set(id, job);
  await redis.lpush(`swarm:${TENANT}:debugger`, id);
  return job;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, tenant: TENANT, jobs: jobs.size, runnerJobs: runnerJobs.size, runnerQueued: runnerQueue.length, roles: ROLES, redis: redis.ok });
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") return json(res, 200, { jobs: [...jobs.values()] });
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const payload = await readJson(req);
      const denied = admit(payload.objective);
      if (denied) return json(res, 400, { error: denied });
      return json(res, 202, await createSwarmJob(payload.objective));
    }
    if (req.method === "POST" && url.pathname === "/api/multi-agent-debug") {
      const payload = await readJson(req);
      const denied = admit(payload.objective);
      if (denied) return json(res, 400, { error: denied });
      const job = await createSwarmJob(payload.objective);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && job.status !== "completed" && job.status !== "failed") {
        await new Promise((r) => setTimeout(r, 400));
      }
      return json(res, job.status === "completed" ? 200 : 202, {
        success: job.status === "completed",
        status: job.status,
        jobId: job.id,
        agents: job.events.map((e) => e.role),
        events: job.events,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/events") {
      const payload = await readJson(req);
      const job = jobs.get(payload.jobId);
      if (!job) return json(res, 404, { error: "unknown job" });
      if (job.status === "completed" || job.status === "failed") return json(res, 409, { error: "job already terminal" });
      if (payload.status !== "passed" && payload.status !== "failed") return json(res, 400, { error: "event status must be passed or failed" });
      const expectedRole = ROLES[job.step];
      if (payload.role !== expectedRole) return json(res, 409, { error: "out-of-order role", expected: expectedRole, received: payload.role });
      job.events.push({ role: payload.role, status: payload.status, note: String(payload.note || "").slice(0, 500), at: new Date().toISOString() });
      if (payload.status === "passed" && job.step < ROLES.length - 1) {
        job.step += 1; job.status = "running"; await redis.lpush(`swarm:${TENANT}:${ROLES[job.step]}`, job.id);
      } else if (payload.status === "passed") job.status = "completed";
      else if (payload.status === "failed") job.status = "failed";
      return json(res, 200, job);
    }
    if (req.method === "GET" && url.pathname === "/api/runner/jobs") return json(res, 200, { jobs: [...runnerJobs.values()] });
    if (req.method === "POST" && url.pathname === "/api/runner/jobs") {
      const payload = await readJson(req);
      const id = `run-${runSeq++}`;
      const job = { id, kind: String(payload.kind || "prove-success"), query: String(payload.query || "").slice(0, 80), objective: String(payload.objective || payload.query || "").slice(0, 2000), status: "queued", createdAt: new Date().toISOString() };
      runnerJobs.set(id, job); runnerQueue.push(id);
      return json(res, 202, job);
    }
    if (req.method === "POST" && url.pathname === "/api/runner/claim") {
      const id = runnerQueue.shift();
      if (!id) { res.writeHead(204); return res.end(); }
      const job = runnerJobs.get(id); job.status = "running"; job.claimedAt = new Date().toISOString();
      return json(res, 200, job);
    }
    if (req.method === "POST" && url.pathname === "/api/runner/complete") {
      const payload = await readJson(req);
      const job = runnerJobs.get(payload.id);
      if (!job) return json(res, 404, { error: "unknown runner job" });
      job.status = payload.ok ? "completed" : "failed";
      job.runner = payload.runner;
      job.note = String(payload.note || "").slice(0, 500);
      job.hits = payload.hits || undefined;
      job.spawned = payload.spawned || undefined;
      job.completedAt = new Date().toISOString();
      return json(res, 200, job);
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      if (q.length < 2) return json(res, 400, { error: "q min 2 chars" });
      const hits = [];
      for (const job of jobs.values()) {
        if (`${job.id} ${job.objective} ${job.status}`.toLowerCase().includes(q)) hits.push({ type: "swarm", id: job.id, status: job.status, objective: job.objective });
      }
      for (const job of runnerJobs.values()) {
        if (`${job.id} ${job.kind} ${job.query || ""} ${job.note || ""}`.toLowerCase().includes(q)) hits.push({ type: "runner", id: job.id, kind: job.kind, status: job.status });
      }
      return json(res, 200, { q, hits: hits.slice(0, 20) });
    }
    json(res, 404, { error: "not found" });
  } catch {
    json(res, 400, { error: "invalid json" });
  }
});

server.listen(PORT, () => console.log(`coordinator listening on ${PORT} tenant=${TENANT}`));
