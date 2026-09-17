const COORDINATOR = process.env.COORDINATOR_URL || "http://127.0.0.1:4100";
const NAME = process.env.INTERNAL_RUNNER_NAME || "control12-internal-1";
const POLL_MS = Number(process.env.POLL_MS || 3000);
const ALLOWED = new Set(["prove-success", "health-probe", "inventory"]);

async function claim() {
  const res = await fetch(`${COORDINATOR}/api/runner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runner: NAME }),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`claim ${res.status}`);
  return res.json();
}

async function complete(id, result) {
  await fetch(`${COORDINATOR}/api/runner/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, runner: NAME, ...result }),
  });
}

function runAllowlisted(job) {
  const kind = job.kind || "prove-success";
  if (!ALLOWED.has(kind)) return { ok: false, note: `rejected unlisted kind:${kind}` };
  if (kind === "health-probe") return { ok: true, note: `${NAME} health-probe ${process.platform} ${process.arch}` };
  if (kind === "inventory") return { ok: true, note: `${NAME} cwd=${process.cwd()} pid=${process.pid}` };
  return { ok: true, note: `${NAME} prove-success allowlisted` };
}

async function tick() {
  const job = await claim();
  if (!job) return;
  const result = runAllowlisted(job);
  await complete(job.id, result);
  console.log(`${NAME} ${job.id} ${result.ok ? "ok" : "deny"} ${result.note}`);
}

console.log(`internal runner ${NAME} polling ${COORDINATOR}`);
setInterval(() => tick().catch((err) => console.error(NAME, err.message)), POLL_MS);
tick().catch((err) => console.error(NAME, err.message));
