import fs from "node:fs";
import path from "node:path";
const COORDINATOR = process.env.COORDINATOR_URL || "http://127.0.0.1:4100";
const NAME = process.env.INTERNAL_RUNNER_NAME || "control12-internal-1";
const ROOT = process.env.SWARM_ROOT || path.resolve(".");
const POLL_MS = Number(process.env.POLL_MS || 3000);
const API_TOKEN = process.env.SWARM_API_TOKEN || "";
const READ_TOKEN = process.env.SWARM_READ_TOKEN || "";
const RUNNER_TOKEN = process.env.SWARM_RUNNER_TOKEN || "";
for (const [name, value] of Object.entries({ SWARM_API_TOKEN: API_TOKEN, SWARM_READ_TOKEN: READ_TOKEN, SWARM_RUNNER_TOKEN: RUNNER_TOKEN })) {
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
}
const ALLOWED = new Set(["prove-success", "health-probe", "inventory", "search", "spawn-subagent"]);
async function claim() {
  const res = await fetch(`${COORDINATOR}/api/runner/claim`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${RUNNER_TOKEN}` }, body: JSON.stringify({ runner: NAME }) });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`claim ${res.status}`);
  return res.json();
}
async function complete(id, result) {
  await fetch(`${COORDINATOR}/api/runner/complete`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${RUNNER_TOKEN}` }, body: JSON.stringify({ id, runner: NAME, ...result }) });
}
function safeQuery(raw) {
  const q = String(raw || "").trim().slice(0, 80);
  return /^[a-zA-Z0-9._\-\/ ]{2,80}$/.test(q) ? q : null;
}
function walkHits(dir, needle, acc, depth = 0) {
  if (acc.length >= 20 || depth > 6) return acc;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (acc.length >= 20) break;
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.toLowerCase().includes(needle.toLowerCase())) acc.push({ type: "dir", path: path.relative(ROOT, full) });
      walkHits(full, needle, acc, depth + 1);
    } else if (ent.isFile()) {
      const rel = path.relative(ROOT, full);
      let hit = rel.toLowerCase().includes(needle.toLowerCase());
      if (!hit && /\.(js|mjs|md|yml|json|sh|html|txt)$/i.test(ent.name)) {
        try { hit = fs.readFileSync(full, "utf8").toLowerCase().includes(needle.toLowerCase()); } catch { hit = false; }
      }
      if (hit) acc.push({ type: "file", path: rel });
    }
  }
  return acc;
}
async function search(job) {
  const q = safeQuery(job.query || job.objective);
  if (!q) return { ok: false, note: "search query rejected" };
  const local = walkHits(ROOT, q, []);
  let remote = { hits: [] };
  try { const res = await fetch(`${COORDINATOR}/api/search?q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } }); if (res.ok) remote = await res.json(); } catch {}
  return { ok: true, note: `${NAME} search q=${q} hits=${local.length + (remote.hits||[]).length}`, hits: [...local, ...(remote.hits||[])].slice(0, 20) };
}
async function spawnSubagent(job) {
  const objective = String(job.objective || job.query || "spawned by internal runner").slice(0, 2000);
  const res = await fetch(`${COORDINATOR}/api/jobs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` }, body: JSON.stringify({ objective }) });
  if (!res.ok) return { ok: false, note: `spawn failed ${res.status}` };
  const spawned = await res.json();
  return { ok: true, note: `${NAME} spawned ${spawned.id} chain=${(spawned.chain||[]).join(">")}`, spawned };
}
async function runAllowlisted(job) {
  const kind = job.kind || "prove-success";
  if (!ALLOWED.has(kind)) return { ok: false, note: `rejected unlisted kind:${kind}` };
  if (kind === "health-probe") return { ok: true, note: `${NAME} health-probe ${process.platform} ${process.arch}` };
  if (kind === "inventory") return { ok: true, note: `${NAME} cwd=${process.cwd()} pid=${process.pid}` };
  if (kind === "search") return search(job);
  if (kind === "spawn-subagent") return spawnSubagent(job);
  return { ok: true, note: `${NAME} prove-success allowlisted` };
}
async function tick() {
  const job = await claim();
  if (!job) return;
  const result = await runAllowlisted(job);
  await complete(job.id, result);
  console.log(`${NAME} ${job.id} ${result.ok ? "ok" : "deny"} ${result.note}`);
}
console.log(`internal runner ${NAME} polling ${COORDINATOR} allow=${[...ALLOWED].join(",")}`);
setInterval(() => tick().catch((err) => console.error(NAME, err.message)), POLL_MS);
tick().catch((err) => console.error(NAME, err.message));
