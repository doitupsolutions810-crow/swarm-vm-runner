import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let child;
let base;

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(base + "/health");
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("coordinator failed to become healthy");
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(here, ".."),
    env: { ...process.env, PORT: String(port), REDIS_URL: "memory://test", SWARM_TENANT: "ci-test" },
    stdio: "ignore"
  });
  await waitHealthy();
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(2000)]);
  }
});

test("health endpoint is live", async () => {
  const response = await fetch(base + "/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("job requires the exact ordered role chain and becomes terminal", async () => {
  const created = await fetch(base + "/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "ci role-order regression" })
  });
  assert.equal(created.status, 202);
  const job = await created.json();
  assert.ok(job.id);

  const wrong = await fetch(base + "/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.id, role: "coder", status: "passed" })
  });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).expected, "debugger");

  for (const role of ["debugger", "coder", "tester", "governance"]) {
    const response = await fetch(base + "/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.id, role, status: "passed" })
    });
    assert.equal(response.status, 200);
  }

  const jobs = await (await fetch(base + "/api/jobs")).json();
  const finalJob = jobs.jobs.find(item => item.id === job.id);
  assert.equal(finalJob.status, "completed");
  assert.deepEqual(finalJob.events.map(event => event.role), ["debugger", "coder", "tester", "governance"]);

  const duplicate = await fetch(base + "/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.id, role: "governance", status: "passed" })
  });
  assert.equal(duplicate.status, 409);
});

test("unknown job events are rejected", async () => {
  const response = await fetch(base + "/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: "missing-job", role: "debugger", status: "passed" })
  });
  assert.equal(response.status, 404);
});
