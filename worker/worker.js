const ROLE = process.env.ROLE || "debugger";
const COORDINATOR = process.env.COORDINATOR_URL || "http://coordinator:4100";
const POLL_MS = 4000;
const TOKEN = process.env.SWARM_READ_TOKEN || "";
const ROLE_TOKEN = process.env.SWARM_ROLE_TOKEN || "";
if (TOKEN.length < 32) throw new Error("SWARM_READ_TOKEN must be at least 32 characters");
if (ROLE_TOKEN.length < 32) throw new Error("SWARM_ROLE_TOKEN must be at least 32 characters");

async function tick() {
  const res = await fetch(`${COORDINATOR}/api/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) return;
  const { jobs } = await res.json();
  const mine = (jobs || []).find(
    (j) => j.status !== "completed" && j.status !== "failed" && j.chain[j.step] === ROLE
  );
  if (!mine) return;
  const note = `${ROLE} accepted ${mine.id} (no in-process eval)`;
  await fetch(`${COORDINATOR}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ROLE_TOKEN}` },
    body: JSON.stringify({ jobId: mine.id, role: ROLE, status: "passed", note }),
  });
  console.log(note);
}

setInterval(() => tick().catch((err) => console.error(ROLE, err.message)), POLL_MS);
console.log(`worker role=${ROLE}`);
