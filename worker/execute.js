export async function executeRoleTask({ job, role, coordinatorUrl, executorUrl, readToken, roleToken, executorToken, fetchImpl = fetch }) {
  if (!job || typeof job.id !== "string" || typeof job.objective !== "string") throw new Error("invalid coordinator job");
  if (!["debugger", "coder", "tester", "governance"].includes(role)) throw new Error("invalid specialist role");
  for (const [name, value] of Object.entries({ readToken, roleToken, executorToken })) {
    if (typeof value !== "string" || value.length < 32) throw new Error(name + " must be at least 32 characters");
  }
  let executionResponse;
  try {
    executionResponse = await fetchImpl(executorUrl, {
      method: "POST",
      headers: { authorization: "Bearer " + executorToken, "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.id, role, objective: job.objective }),
      signal: AbortSignal.timeout(35_000),
    });
  } catch (error) {
    return { reported: false, pending: true, reason: "executor transport unavailable: " + error.message };
  }
  let result;
  try { result = await executionResponse.json(); }
  catch { return { reported: false, pending: true, reason: "executor returned non-JSON response" }; }
  if (![200, 422].includes(executionResponse.status)) return { reported: false, pending: true, reason: "executor unavailable (" + executionResponse.status + ")" };
  if (!result?.evidence || typeof result.evidence_signature !== "string"
      || result.evidence.job_id !== job.id || result.evidence.role !== role
      || !["succeeded", "failed"].includes(result.evidence.status)) {
    return { reported: false, pending: true, reason: "executor response lacks matching signed evidence" };
  }
  const expected = result.evidence.status === "succeeded" ? "passed" : "failed";
  if ((executionResponse.status === 200) !== (expected === "passed")) return { reported: false, pending: true, reason: "executor HTTP status does not match evidence status" };
  const note = JSON.stringify(result.evidence.report || {}).slice(0, 500);
  let report;
  try {
    report = await fetchImpl(coordinatorUrl + "/api/events", {
      method: "POST",
      headers: { authorization: "Bearer " + roleToken, "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.id, role, status: expected, note, evidence: result.evidence, evidence_signature: result.evidence_signature }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { reported: false, pending: true, reason: "coordinator report outcome unknown: " + error.message };
  }
  if (!report.ok) return { reported: false, pending: true, reason: "coordinator rejected evidence (" + report.status + ")" };
  return { reported: true, status: expected, evidence: result.evidence };
}
