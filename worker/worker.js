const ROLE = process.env.ROLE || "debugger";
const COORDINATOR = process.env.COORDINATOR_URL || "http://coordinator:4100";
const POLL_MS = 4000;

async function tick() {
  const res = await fetch(`${COORDINATOR}/api/jobs`);
  if (!res.ok) return;
  const { jobs } = await res.json();
  const mine = (jobs || []).find(
    (j) => j.status !== "completed" && j.status !== "failed" && j.chain[j.step] === ROLE
  );
  if (!mine) return;
  const note = `${ROLE} accepted ${mine.id} (no in-process eval)`;
  await fetch(`${COORDINATOR}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: mine.id, role: ROLE, status: "passed", note }),
  });
  console.log(note);
}

setInterval(() => tick().catch((err) => console.error(ROLE, err.message)), POLL_MS);
console.log(`worker role=${ROLE}`);
