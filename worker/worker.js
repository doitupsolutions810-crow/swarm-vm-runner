import { randomUUID } from "node:crypto";
import { executeRoleTask } from "./execute.js";

const ROLE = process.env.ROLE || "debugger";
const COORDINATOR = process.env.COORDINATOR_URL || "http://coordinator:4100";
const EXECUTOR_URL = process.env.SWARM_EXECUTOR_URL || "http://grok-bot:3000/api/swarm/execute";
const configuredPollMs = Number(process.env.POLL_MS || 4000);
const POLL_MS = Number.isFinite(configuredPollMs) ? Math.max(1000, Math.min(60000, configuredPollMs)) : 4000;
const TOKEN = process.env.SWARM_READ_TOKEN || "";
const ROLE_TOKEN = process.env.SWARM_ROLE_TOKEN || "";
const WORKER_ID = process.env.WORKER_ID || ROLE + "-" + randomUUID();
const LEASE_MS = 600000;
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
    const res = await fetch(COORDINATOR + "/api/worker/" + ROLE + "/claim", {
      method: "POST",
      headers: { authorization: "Bearer " + ROLE_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ workerId: WORKER_ID, leaseMs: LEASE_MS }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 204) return;
    if (!res.ok) throw new Error("claim rejected (" + res.status + ")");
    const mine = await res.json();
    const executionController = new AbortController();
    const heartbeat = setInterval(async () => {
      try {
        const renewed = await fetch(COORDINATOR + "/api/worker/" + ROLE + "/renew", {
          method: "POST",
          headers: { authorization: "Bearer " + ROLE_TOKEN, "content-type": "application/json" },
          body: JSON.stringify({ jobId: mine.id, workerId: WORKER_ID, claimToken: mine.claimToken, leaseMs: LEASE_MS }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!renewed.ok) {
          console.error(ROLE, mine.id, "lease renewal rejected (" + renewed.status + "); cancelling execution");
          executionController.abort(new Error("specialist lease renewal rejected"));
        }
      } catch (error) {
        console.error(ROLE, mine.id, "lease renewal unavailable; cancelling execution:", error.message);
        executionController.abort(error);
      }
    }, Math.floor(LEASE_MS / 3));
    let result;
    try {
      result = await executeRoleTask({
        job: mine, role: ROLE, coordinatorUrl: COORDINATOR, executorUrl: EXECUTOR_URL,
        readToken: TOKEN, roleToken: ROLE_TOKEN, executorToken: EXECUTOR_TOKEN,
        claimToken: mine.claimToken, signal: executionController.signal,
      });
    } finally {
      clearInterval(heartbeat);
    }
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
console.log("worker role=" + ROLE + " id=" + WORKER_ID + " executor=" + EXECUTOR_URL);
