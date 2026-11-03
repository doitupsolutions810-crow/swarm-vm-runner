import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { verifySignedEvidence } from "./integration-contract.js";

export const SWARM_ROLES = ["debugger", "coder", "tester", "governance"];

export function smokeArtifactPaths(runTag) {
  if (typeof runTag !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runTag)) throw new TypeError("invalid smoke run tag");
  const suffix = runTag.replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    textFile: `swarm-smoke-${suffix}.txt`,
    testFile: `swarm-smoke-${suffix}.test.js`
  };
}

export function buildSmokeObjective(runTag, repository, branch = "") {
  if (typeof runTag !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runTag)) throw new TypeError("invalid smoke run tag");
  if (typeof repository !== "string" || !/^https:\/\//.test(repository)) throw new TypeError("SWARM_SMOKE_REPOSITORY must be an HTTPS Git URL");
  const suffix = runTag.replace(/[^a-zA-Z0-9_-]/g, "-");
  const { textFile: txt, testFile: spec } = smokeArtifactPaths(runTag);
  const expectedContent = "swarm execution verified for " + suffix;
  const testSource = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { readFile } from "node:fs/promises";',
    `test("swarm smoke artifact matches the expected content", async () => {`,
    `  assert.equal(await readFile("${txt}", "utf8"), "${expectedContent}");`,
    "});"
  ].join("\n");
  const branchText = branch ? `The configured checkout branch is ${branch}. Do not switch branches.` : "Use the configured checkout branch.";
  return [
    "REAL FOUR-ROLE SWARM ACCEPTANCE TASK.",
    `Target repository: ${repository}`,
    branchText,
    "Work only inside the existing per-job workspace checkout. Do not commit, push, publish, or modify existing project files.",
    `Create ${txt} with exactly this one line: ${expectedContent}`,
    `Create ${spec} with exactly this source:\n${testSource}`,
    `The test must run with: node --test ${spec}`,
    "Debugger: inspect the checkout and report the repository state and the planned non-destructive test.",
    "Coder: create only the two named smoke files and run the exact node --test command.",
    "Tester: independently run the exact node --test command and report its actual exit code.",
    "Governance: independently inspect both files, rerun the test, verify no existing files were changed, and approve only if every check passes.",
    "Do not fabricate terminal results, artifacts, hashes, or test outcomes."
  ].join("\n");
}

export function validateCompletedJob(job, {
  expectedJobId, expectedTenant, expectedExecutor, expectedArtifactPaths = [], expectedTestCommand = "", publicKeyPem, nowMs = Date.now()
}) {
  if (!job || job.id !== expectedJobId || job.tenant !== expectedTenant || job.status !== "completed") {
    throw new Error("smoke job identity, tenant, or completion status mismatch");
  }
  if (!Array.isArray(job.events) || job.events.length !== SWARM_ROLES.length) throw new Error("smoke job must contain exactly four specialist events");
  for (let i = 0; i < SWARM_ROLES.length; i++) {
    const event = job.events[i];
    const role = SWARM_ROLES[i];
    if (event.role !== role || event.status !== "passed" || event.evidence?.status !== "succeeded") {
      throw new Error("specialist event failed or role order mismatch: " + role);
    }
    verifySignedEvidence({
      evidence: event.evidence,
      signature: event.evidence_signature,
      publicKeyPem,
      expectedJobId,
      expectedRole: role,
      expectedExecutor,
      nowMs
    });
  }
  const [debugger, coder, tester, governance] = job.events.map(event => event.evidence.report);
  if (typeof debugger.diagnosis !== "string" || !debugger.diagnosis.trim()
      || typeof debugger.reproduction !== "string" || !debugger.reproduction.trim()) {
    throw new Error("debugger report incomplete");
  }
  if (!Array.isArray(coder.artifacts) || coder.artifacts.length === 0
      || !coder.artifacts.every(item => typeof item.path === "string" && /^sha256:[a-f0-9]{64}$/.test(item.sha256 || ""))) {
    throw new Error("coder artifacts missing or malformed");
  }
  if (!expectedArtifactPaths.length || !expectedArtifactPaths.every(path => coder.artifacts.some(item => item.path === path))) {
    throw new Error("coder did not produce both uniquely named smoke artifacts");
  }
  if (!Array.isArray(tester.tests) || !tester.tests.length || !tester.tests.every(item => typeof item.command === "string" && item.exit_code === 0)
      || !tester.tests.some(item => item.command === expectedTestCommand)) {
    throw new Error("tester did not provide successful smoke test evidence");
  }
  const requiredGovernanceChecks = ["successful terminal execution", "artifact inventory", "successful test command", "explicit governance approval"];
  if (governance.decision !== "approve" || !Array.isArray(governance.checks)
      || !requiredGovernanceChecks.every(name => governance.checks.some(item => item.name === name && item.passed === true))) {
    throw new Error("governance did not independently approve all required checks");
  }
  return {
    jobId: job.id,
    tenant: job.tenant,
    status: job.status,
    roles: job.events.map(event => ({ role: event.role, status: event.status, executor: event.evidence.executor })),
    artifactCount: coder.artifacts.length,
    testCommands: tester.tests.map(item => item.command),
    governance: governance.decision
  };
}

async function requestJson(fetchImpl, url, token, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: { ...(options.headers || {}), authorization: "Bearer " + token, "content-type": "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error || "request failed"}`);
  return body;
}

export async function runSwarmSmoke({ env = process.env, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const baseUrl = String(env.COORDINATOR_URL || "http://127.0.0.1:4100").replace(/\/+$/, "");
  const coordinatorToken = env.SWARM_TOKEN || "";
  const readToken = env.SWARM_READ_TOKEN || "";
  const tenant = env.SWARM_TENANT || "";
  const executorId = env.SWARM_EXECUTOR_ID || "";
  const publicKeyPath = env.SWARM_EXECUTOR_PUBLIC_KEY_FILE || "";
  const repository = env.SWARM_SMOKE_REPOSITORY || "";
  const branch = env.SWARM_SMOKE_BRANCH || "";
  if ([coordinatorToken, readToken, tenant, executorId, publicKeyPath, repository].some(value => !value)) {
    throw new Error("configure SWARM_TOKEN, SWARM_READ_TOKEN, SWARM_TENANT, SWARM_EXECUTOR_ID, SWARM_EXECUTOR_PUBLIC_KEY_FILE, and SWARM_SMOKE_REPOSITORY");
  }
  const timeoutMs = Math.max(60000, Math.min(3600000, Number(env.SWARM_SMOKE_TIMEOUT_MS || 900000)));
  const pollMs = Math.max(500, Math.min(15000, Number(env.SWARM_SMOKE_POLL_MS || 2000)));
  const publicKeyPem = readFileSync(publicKeyPath, "utf8");
  const runTag = "smoke-" + randomUUID();
  const objective = buildSmokeObjective(runTag, repository, branch);
  const expectedArtifactPaths = Object.values(smokeArtifactPaths(runTag));
  const expectedTestCommand = "node --test " + expectedArtifactPaths[1];
  const created = await requestJson(fetchImpl, baseUrl + "/api/jobs", coordinatorToken, {
    method: "POST",
    body: JSON.stringify({ objective })
  });
  if (typeof created.id !== "string") throw new Error("coordinator did not return a job ID");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await requestJson(fetchImpl, baseUrl + "/api/jobs", readToken);
    const job = snapshot.jobs?.find(item => item.id === created.id);
    if (!job) throw new Error("smoke job disappeared from coordinator queue");
    if (job.status === "completed") {
      return validateCompletedJob(job, {
        expectedJobId: created.id, expectedTenant: tenant, expectedExecutor: executorId,
        expectedArtifactPaths, expectedTestCommand, publicKeyPem
      });
    }
    if (job.status === "failed") {
      const details = (job.events || []).map(event => event.role + ":" + event.status + ":" + (event.note || "")).join(" | ");
      throw new Error("four-role smoke job failed: " + details);
    }
    await sleep(pollMs);
  }
  throw new Error("four-role smoke job timed out after " + timeoutMs + "ms; inspect coordinator events and worker logs");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSwarmSmoke().then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }).catch(error => {
    process.stderr.write("[swarm-smoke] " + (error.message || String(error)) + "\n");
    process.exitCode = 1;
  });
}
