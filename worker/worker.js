import { executeRoleTask } from "./execute.js";

const ROLE = process.env.ROLE || "debugger";
const COORDINATOR = process.env.COORDINATOR_URL || "http://coordinator:4100";
const EXECUTOR_URL = process.env.SWARM_EXECUTOR_URL || "http://grok-bot:3000/api/swarm/execute";
const POLL_MS = Math.max(1000, Math.min(60000, Number(process.env.POLL_MS || 4000)));
const TOKEN = process.env.SWARM_READ_TOKEN || "";
const ROLE_TOKEN = process.env.SWARM_ROLE_TOKEN || "";
const EXECUTOR_TOKEN = process.env.SWARM_EXECUTOR_TOKEN || "";
if (!["debugger", "coder", "tester", "governance"].includes(ROLE)) throw new Error("unknown worker role");
if (TOKEN.length < 32) throw new Error("SWARM_READ_TOKEN must be at least 32 characters");
if (ROLE_TOKEN.length < 32) throw new Error("SWARM_ROLE_TOKEN must be at least 32 characters");
if (EXECUTOR_TOKEN.length < 32) throw new Error("SWARM_EXECUTOR_TOKEN must be at least 32 characters");

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const res = await fetch(COORDINATOR + "/api/jobs", { headers: { authorization: "Bearer " + TOKEN } });
    if (!res.ok) return;
    const body = await res.json();
    const mine = (body.jobs || []).find((job) => job.status !== "completed" && job.status !== "failed" && job.chain?.[job.step] === ROLE);
    if (!mine) return;
    const result = await executeRoleTask({
      job: mine, role: ROLE, coordinatorUrl: COORDINATOR, executorUrl: EXECUTOR_URL,
      readToken: TOKEN, roleToken: ROLE_TOKEN, executorToken: EXECUTOR_TOKEN,
    });
    if (!result.reported) {
      console.error(ROLE, mine.id, result.reason || "execution remains pending");
      return;
    }
    console.log(ROLE, mine.id, result.status, result.evidence.run_id);
  } catch (error) {
    console.error(ROLE, error.message);
  } finally {
    busy = false;
  }
}

tick();
setInterval(tick, POLL_MS);
console.log("worker role=" + ROLE + " executor=" + EXECUTOR_URL);
