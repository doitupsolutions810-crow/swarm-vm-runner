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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, tenant: TENANT, jobs: jobs.size, runnerJobs: runnerJobs.size, runnerQueued: runnerQueue.length, roles: ROLES, redis: redis.ok });
  }
  if (req.method === "GET" && url.pathname === "/api/jobs") return json(res, 200, { jobs: [...jobs.values()] });
  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const chunks = []; for await (const c of req) chunks.push(c);
    let payload = {}; try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
    if (!payload.objective || String(payload.objective).length > 2000) return json(res, 400, { error: "objective required" });
    const id = `job-${seq++}`;
    const job = { id, tenant: TENANT, objective: payload.objective, status: "queued", chain: ROLES, step: 0, createdAt: new Date().toISOString(), events: [] };
    jobs.set(id, job);
    await redis.lpush(`swarm:${TENANT}:debugger`, id);
    return json(res, 202, job);
  }
  if (req.method === "POST" && url.pathname === "/api/events") {
    const chunks = []; for await (const c of req) chunks.push(c);
    let payload = {}; try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
    const job = jobs.get(payload.jobId);
    if (!job) return json(res, 404, { error: "unknown job" });
    job.events.push({ role: payload.role, status: payload.status, note: String(payload.note || "").slice(0, 500), at: new Date().toISOString() });
    if (payload.status === "passed" && job.step < ROLES.length - 1) { job.step += 1; job.status = "running"; await redis.lpush(`swarm:${TENANT}:${ROLES[job.step]}`, job.id); }
    else if (payload.status === "passed") job.status = "completed";
    else if (payload.status === "failed") job.status = "failed";
    return json(res, 200, job);
  }
  if (req.method === "GET" && url.pathname === "/api/runner/jobs") return json(res, 200, { jobs: [...runnerJobs.values()] });
  if (req.method === "POST" && url.pathname === "/api/runner/jobs") {
    const chunks = []; for await (const c of req) chunks.push(c);
    let payload = {}; try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
    const id = `run-${runSeq++}`;
    const job = { id, kind: String(payload.kind || "prove-success"), status: "queued", createdAt: new Date().toISOString() };
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
    const chunks = []; for await (const c of req) chunks.push(c);
    let payload = {}; try { payload = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return json(res, 400, { error: "invalid json" }); }
    const job = runnerJobs.get(payload.id);
    if (!job) return json(res, 404, { error: "unknown runner job" });
    job.status = payload.ok ? "completed" : "failed";
    job.runner = payload.runner;
    job.note = String(payload.note || "").slice(0, 500);
    job.completedAt = new Date().toISOString();
    return json(res, 200, job);
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`coordinator listening on ${PORT} tenant=${TENANT}`));
