import http from "node:http";
import { createPublicKey, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { authorizeAndEnqueue } from "./integration-adapter.js";
import { digestJson, verifySignedReceipt, verifySignedEvidence } from "./integration-contract.js";

const PORT = Number(process.env.PORT || 4100);
const TENANT = process.env.SWARM_TENANT || "control12";
const ROLES = Object.freeze(["debugger", "coder", "tester", "governance"]);
const RUNNER_KINDS = new Set(["prove-success", "health-probe", "inventory", "search", "spawn-subagent"]);
const MAX_BODY = 16 * 1024;
const MAX_OBJECTIVE = 2000;

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.resume();
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    const error = new Error("application/json required");
    error.status = 415;
    throw error;
  }
  let value;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    value = JSON.parse(decoded || "{}");
  }
  catch {
    const error = new Error("invalid json");
    error.status = 400;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("json object required");
    error.status = 400;
    throw error;
  }
  return value;
}

function tokenMatches(expected, supplied) {
  if (typeof expected !== "string" || expected.length < 32) return false;
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req, token) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer ([A-Za-z0-9._~+\/-]{32,512})$/.exec(header);
  return Boolean(match && tokenMatches(token, match[1]));
}

function validObjective(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_OBJECTIVE;
}

function loadSecret(value, filePath) {
  if (typeof value === "string" && value.length) return value;
  if (typeof filePath === "string" && filePath.length) return fs.readFileSync(filePath, "utf8");
  return "";
}

function validCredentialSet(token, readToken, runnerToken, roleTokens) {
  const values = [token, readToken, runnerToken, ...ROLES.map((role) => roleTokens?.[role])];
  return values.every((value) => typeof value === "string" && value.length >= 32)
    && new Set(values).size === values.length;
}

export function createServer({
  token = process.env.SWARM_API_TOKEN,
  readToken = process.env.SWARM_READ_TOKEN,
  runnerToken = process.env.SWARM_RUNNER_TOKEN,
  roleTokens = {
    debugger: process.env.SWARM_DEBUGGER_TOKEN,
    coder: process.env.SWARM_CODER_TOKEN,
    tester: process.env.SWARM_TESTER_TOKEN,
    governance: process.env.SWARM_GOVERNANCE_TOKEN,
  },
  tenant = TENANT,
  stateDir = process.env.SWARM_STATE_DIR || "/var/swarm",
  compactAfterRecords = Number(process.env.SWARM_COMPACT_AFTER_RECORDS || 500),
  avroneIssuerPublicKeyPem = loadSecret(process.env.SWARM_AVRONE_ISSUER_PUBLIC_KEY_PEM, process.env.SWARM_AVRONE_ISSUER_PUBLIC_KEY_FILE),
  capabilityAuthorityPublicKeyB64 = process.env.SWARM_CAPABILITY_AUTHORITY_PUBLIC_KEY_B64 || "",
  swarmReceiptPrivateKeyPem = loadSecret(process.env.SWARM_RECEIPT_SIGNING_PRIVATE_KEY_PEM, process.env.SWARM_RECEIPT_SIGNING_PRIVATE_KEY_FILE),
  executorPublicKeyPem = loadSecret(process.env.SWARM_EXECUTOR_PUBLIC_KEY_PEM, process.env.SWARM_EXECUTOR_PUBLIC_KEY_FILE),
  executorId = process.env.SWARM_EXECUTOR_ID || "",
  now = () => Date.now(),
  avroneIssuer = process.env.SWARM_AVRONE_ISSUER || "",
  swarmAudience = process.env.SWARM_SERVICE_IDENTITY || "",
  capabilityAuthorityIssuer = process.env.SWARM_CAPABILITY_AUTHORITY_ISSUER || "spiffe://prod/broker",
} = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const journalPath = path.join(stateDir, "coordinator.jsonl");
  const jobs = new Map();
  const runnerJobs = new Map();
  const runnerQueue = [];
  const integrationMessages = new Map();
  const integrationCorrelations = new Map();
  const receiptPublicKeyPem = swarmReceiptPrivateKeyPem
    ? createPublicKey(swarmReceiptPrivateKeyPem).export({ type: "spki", format: "pem" })
    : "";
  let lastReceiptDigest = null;

  function recoverReceipt(record, jobId) {
    if (!receiptPublicKeyPem) throw new Error("receipt signing key is required to recover signed integration history");
    verifySignedReceipt({ receipt: record.receipt, publicKeyPem: receiptPublicKeyPem });
    if (record.receipt.previous_receipt_digest !== lastReceiptDigest) throw new Error("signed receipt chain is broken");
    if (record.receipt.message_id !== record.message_id
        || record.receipt.correlation_id !== record.correlation_id
        || record.receipt.capability_id !== record.capability_id
        || record.receipt.payload_digest !== record.payload_digest
        || record.receipt.action !== record.action) {
      throw new Error("signed receipt does not match its journal record");
    }
    const ledger = {
      messageId: record.message_id,
      correlationId: record.correlation_id,
      payloadDigest: record.payload_digest,
      capabilityId: record.capability_id,
      action: record.action,
      jobId,
      receipt: record.receipt,
    };
    integrationMessages.set(ledger.messageId, ledger);
    integrationCorrelations.set(ledger.correlationId, ledger);
    lastReceiptDigest = digestJson(record.receipt);
  }
  let seq = 1;
  let runSeq = 1;
  let persistQueue = Promise.resolve();
  let stateMutationQueue = Promise.resolve();
  let journalRecords = 0;
  const compactPath = journalPath + ".compact.tmp";
  try { fs.unlinkSync(compactPath); } catch (error) { if (error.code !== "ENOENT") throw error; }

  function repairJournalTail() {
    if (!fs.existsSync(journalPath)) return;
    const raw = fs.readFileSync(journalPath);
    if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
      const lastNewline = raw.lastIndexOf(0x0a);
      fs.truncateSync(journalPath, lastNewline + 1);
    }
  }
  repairJournalTail();

  if (fs.existsSync(journalPath)) {
    const raw = fs.readFileSync(journalPath, "utf8");
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.type === "job" && record.job && typeof record.job.id === "string") {
        jobs.set(record.job.id, record.job);
        const n = Number(record.job.id.replace(/^job-/, ""));
        if (Number.isSafeInteger(n)) seq = Math.max(seq, n + 1);
      } else if (record.type === "runner-job" && record.job && typeof record.job.id === "string") {
        runnerJobs.set(record.job.id, record.job);
        const n = Number(record.job.id.replace(/^run-/, ""));
        if (Number.isSafeInteger(n)) runSeq = Math.max(runSeq, n + 1);
      } else if (record.type === "integration-enqueue" && record.job && record.receipt) {
        jobs.set(record.job.id, record.job);
        const n = Number(record.job.id.replace(/^job-/, ""));
        if (Number.isSafeInteger(n)) seq = Math.max(seq, n + 1);
        recoverReceipt(record, record.job.id);
      } else if (record.type === "integration-ledger" && record.receipt) {
        recoverReceipt(record, record.job_id);
      } else {
        throw new Error("coordinator journal contains an unknown record");
      }
      journalRecords += 1;
    }
  }
  for (const job of runnerJobs.values()) {
    if (job.status === "queued") runnerQueue.push(job.id);
    else if (job.status === "running") {
      job.status = "queued";
      delete job.runner;
      delete job.claimToken;
      delete job.claimedAt;
      delete job.leaseExpiresAt;
      runnerQueue.push(job.id);
      fs.appendFileSync(journalPath, JSON.stringify({ type: "runner-job", job }) + "\n", { mode: 0o600 });
      journalRecords += 1;
    }
  }

  function serializeMutation(operationFn) {
    const operation = stateMutationQueue.then(operationFn);
    stateMutationQueue = operation.catch(() => {});
    return operation;
  }

  async function compactJournal(currentRecord) {
    const jobSnapshot = new Map(jobs);
    const runnerSnapshot = new Map(runnerJobs);
    if (currentRecord.type === "job") jobSnapshot.set(currentRecord.job.id, currentRecord.job);
    else if (currentRecord.type === "runner-job") runnerSnapshot.set(currentRecord.job.id, currentRecord.job);
    const ledgerSnapshot = new Map(integrationMessages);
    if (currentRecord.type === "integration-enqueue" && currentRecord.receipt) {
      const ledger = { messageId: currentRecord.message_id, correlationId: currentRecord.correlation_id, payloadDigest: currentRecord.payload_digest, capabilityId: currentRecord.capability_id, action: currentRecord.action, jobId: currentRecord.job.id, receipt: currentRecord.receipt };
      ledgerSnapshot.set(ledger.messageId, ledger);
      jobSnapshot.set(currentRecord.job.id, currentRecord.job);
    }
    const snapshot = [
      ...[...jobSnapshot.values()].map((job) => ({ type: "job", job })),
      ...[...runnerSnapshot.values()].map((job) => ({ type: "runner-job", job })),
      ...[...ledgerSnapshot.values()].map((ledger) => ({ type: "integration-ledger", message_id: ledger.messageId, correlation_id: ledger.correlationId, payload_digest: ledger.payloadDigest, capability_id: ledger.capabilityId, action: ledger.action, job_id: ledger.jobId, receipt: ledger.receipt })),
    ];
    const handle = await fs.promises.open(compactPath, "w", 0o600);
    try {
      if (snapshot.length) await handle.writeFile(snapshot.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(compactPath, journalPath);
    try {
      const dir = await fs.promises.open(stateDir, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* Directory fsync is not supported on every platform. */ }
    journalRecords = snapshot.length;
  }

  function persist(record) {
    const operation = persistQueue.then(async () => {
      repairJournalTail();
      const handle = await fs.promises.open(journalPath, "a", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      journalRecords += 1;
      if (Number.isInteger(compactAfterRecords) && compactAfterRecords > 0 && journalRecords >= compactAfterRecords) {
        try { await compactJournal(record); } catch { /* Keep the durable append if compaction fails. */ }
      }
    });
    persistQueue = operation.catch(() => {});
    return operation;
  }

  async function createSwarmJob(objective) {
    const id = `job-${seq++}`;
    const job = { id, tenant, objective: objective.trim(), status: "queued", chain: [...ROLES], step: 0, createdAt: new Date().toISOString(), events: [] };
    await persist({ type: "job", job });
    jobs.set(id, job);
    return job;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, tenant, jobs: jobs.size, runnerJobs: runnerJobs.size, runnerQueued: runnerQueue.length, roles: ROLES, persistence: "fsync-jsonl" });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!validCredentialSet(token, readToken, runnerToken, roleTokens)) {
          return json(res, 503, { error: "seven distinct coordinator credentials of at least 32 characters are required" });
        }
        if (req.method === "POST" && url.pathname === "/api/events") {
          const payload = await readJson(req);
          if (!ROLES.includes(payload.role)) return json(res, 400, { error: "unknown worker role" });
          const roleToken = roleTokens?.[payload.role];
          if (typeof roleToken !== "string" || roleToken.length < 32) return json(res, 503, { error: "role authentication is not configured" });
          if (!authorized(req, roleToken)) return json(res, 401, { error: "unauthorized worker role" });
          req.swarmPayload = payload;
        } else if (req.method === "POST" && url.pathname === "/api/integration/enqueue") {
          // The signed envelope and capability are the caller authentication boundary.
        } else {
          const workerRoute = /^\/api\/worker\/(debugger|coder|tester|governance)\/(claim|renew|validate)$/.exec(url.pathname);
          const credential = workerRoute ? roleTokens?.[workerRoute[1]]
            : req.method === "GET" && (url.pathname === "/api/jobs" || url.pathname === "/api/search")
              ? readToken
              : url.pathname.startsWith("/api/runner/") ? runnerToken : token;
          const label = workerRoute ? workerRoute[1] : credential === readToken ? "read" : credential === runnerToken ? "runner" : "coordinator";
          if (typeof credential !== "string" || credential.length < 32) return json(res, 503, { error: `${label} authentication is not configured` });
          if (!authorized(req, credential)) return json(res, 401, { error: `unauthorized ${label} client` });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/integration/enqueue") {
        if (!avroneIssuerPublicKeyPem || !capabilityAuthorityPublicKeyB64 || !swarmReceiptPrivateKeyPem || !avroneIssuer || !swarmAudience) {
          return json(res, 503, { error: "signed integration trust roots and receipt signing key are not configured" });
        }
        const payload = await readJson(req);
        const action = payload.payload?.action;
        const actionKey = action && String(action.type) + ":" + String(action.resource) + ":" + String(action.method);
        const outcome = await serializeMutation(async () => {
          const existingMessage = integrationMessages.get(payload.envelope?.message_id);
          const existingCorrelation = integrationCorrelations.get(payload.envelope?.correlation_id);
          const commit = async ({ objective, receipt }) => {
            const existing = existingMessage || existingCorrelation;
            if (existing) {
              const same = existingMessage === existing && existingCorrelation === existing
                && existing.payloadDigest === payload.envelope.payload_digest
                && existing.capabilityId === payload.capability?.id && existing.action === actionKey;
              if (!same) { const conflict = new Error("message_id or correlation_id replay conflict"); conflict.status = 409; throw conflict; }
              return { job: jobs.get(existing.jobId), receipt: existing.receipt, idempotent_replay: true };
            }
            const id = "job-" + seq++;
            const job = { id, tenant, objective, status: "queued", chain: [...ROLES], step: 0, createdAt: new Date().toISOString(), events: [] };
            const record = { type: "integration-enqueue", job, message_id: payload.envelope.message_id, correlation_id: payload.envelope.correlation_id, payload_digest: payload.envelope.payload_digest, capability_id: payload.capability.id, action: actionKey, receipt };
            await persist(record);
            const ledger = { messageId: record.message_id, correlationId: record.correlation_id, payloadDigest: record.payload_digest, capabilityId: record.capability_id, action: record.action, jobId: job.id, receipt };
            jobs.set(job.id, job); integrationMessages.set(ledger.messageId, ledger); integrationCorrelations.set(ledger.correlationId, ledger);
            lastReceiptDigest = digestJson(receipt);
            return { job, durable: true, idempotent_replay: false };
          };
          const result = await authorizeAndEnqueue({ request: payload, trust: { avroneIssuerPublicKeyPem, avroneIssuer, swarmAudience, capabilityAuthorityPublicKeyB64, capabilityAuthorityIssuer, swarmReceiptPrivateKeyPem }, previousReceiptDigest: lastReceiptDigest, commit });
          return { status: result.idempotent_replay ? 200 : 202, body: result };
        });
        return json(res, outcome.status, outcome.body);
      }
      if (req.method === "GET" && url.pathname === "/api/jobs") {
        const visibleJobs = [...jobs.values()].map((job) => {
          const copy = structuredClone(job);
          if (copy.lease) copy.lease = { role: copy.lease.role, workerId: copy.lease.workerId, expiresAt: copy.lease.expiresAt };
          return copy;
        });
        return json(res, 200, { jobs: visibleJobs });
      }
      const workerRoute = /^\/api\/worker\/(debugger|coder|tester|governance)\/(claim|renew|validate)$/.exec(url.pathname);
      if (req.method === "POST" && workerRoute && workerRoute[2] === "validate") {
        const payload = await readJson(req);
        const role = workerRoute[1];
        if (typeof payload.jobId !== "string" || typeof payload.workerId !== "string"
            || !/^[A-Za-z0-9_.:-]{1,128}$/.test(payload.workerId)
            || typeof payload.claimToken !== "string" || payload.claimToken.length < 32) {
          return json(res, 400, { error: "jobId, workerId, and claimToken required" });
        }
        const job = jobs.get(payload.jobId);
        if (!job) return json(res, 404, { error: "unknown job" });
        const lease = job.lease;
        if (!lease || lease.role !== role || lease.workerId !== payload.workerId || lease.claimToken !== payload.claimToken) {
          return json(res, 403, { error: "active specialist claim does not match" });
        }
        if (Number(lease.expiresAt) <= now()) return json(res, 409, { error: "specialist claim expired" });
        if (job.chain?.[job.step] !== role || job.status === "completed" || job.status === "failed") {
          return json(res, 409, { error: "job is no longer claimable by this role" });
        }
        return json(res, 200, { valid: true, jobId: job.id, role, workerId: lease.workerId, leaseExpiresAt: lease.expiresAt });
      }
      if (req.method === "POST" && workerRoute && workerRoute[2] === "claim") {
        const payload = await readJson(req);
        const role = workerRoute[1];
        if (typeof payload.workerId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(payload.workerId)) return json(res, 400, { error: "valid workerId required" });
        const leaseMs = payload.leaseMs === undefined ? 120000 : payload.leaseMs;
        if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600000) return json(res, 400, { error: "leaseMs must be an integer in 1000..600000" });
        const outcome = await serializeMutation(async () => {
          const timestamp = now();
          for (const candidate of jobs.values()) {
            if (candidate.status === "completed" || candidate.status === "failed" || candidate.chain?.[candidate.step] !== role) continue;
            if (candidate.lease && Number(candidate.lease.expiresAt) > timestamp) continue;
            const next = structuredClone(candidate);
            const claimToken = randomUUID();
            next.lease = { role, workerId: payload.workerId, claimToken, claimedAt: timestamp, expiresAt: timestamp + leaseMs };
            await persist({ type: "job", job: next });
            jobs.set(next.id, next);
            return { status: 200, body: { ...next, claimToken, leaseExpiresAt: next.lease.expiresAt } };
          }
          return { status: 204, body: null };
        });
        if (outcome.status === 204) { res.writeHead(204); return res.end(); }
        return json(res, outcome.status, outcome.body);
      }
      if (req.method === "POST" && workerRoute && workerRoute[2] === "renew") {
        const payload = await readJson(req);
        const role = workerRoute[1];
        if (typeof payload.workerId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(payload.workerId)
            || typeof payload.claimToken !== "string" || payload.claimToken.length < 32) return json(res, 400, { error: "workerId and claimToken required" });
        const leaseMs = payload.leaseMs === undefined ? 120000 : payload.leaseMs;
        if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600000) return json(res, 400, { error: "leaseMs must be an integer in 1000..600000" });
        const outcome = await serializeMutation(async () => {
          const job = jobs.get(payload.jobId);
          if (!job) return { status: 404, body: { error: "unknown job" } };
          const lease = job.lease;
          if (!lease || lease.role !== role || lease.workerId !== payload.workerId || lease.claimToken !== payload.claimToken) return { status: 403, body: { error: "claim does not match" } };
          if (Number(lease.expiresAt) <= now()) return { status: 409, body: { error: "lease expired" } };
          if (job.chain?.[job.step] !== role || job.status === "completed" || job.status === "failed") return { status: 409, body: { error: "job is no longer claimable by this role" } };
          const next = structuredClone(job);
          next.lease.expiresAt = now() + leaseMs;
          await persist({ type: "job", job: next });
          jobs.set(next.id, next);
          return { status: 200, body: { jobId: next.id, role, workerId: payload.workerId, leaseExpiresAt: next.lease.expiresAt } };
        });
        return json(res, outcome.status, outcome.body);
      }
      if (req.method === "POST" && url.pathname === "/api/jobs") {
        const payload = await readJson(req);
        if (!validObjective(payload.objective)) return json(res, 400, { error: "objective required (1..2000 characters)" });
        return json(res, 202, await createSwarmJob(payload.objective));
      }
      if (req.method === "POST" && url.pathname === "/api/multi-agent-debug") {
        const payload = await readJson(req);
        if (!validObjective(payload.objective)) return json(res, 400, { error: "objective required (1..2000 characters)" });
        const job = await createSwarmJob(payload.objective);
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && job.status !== "completed" && job.status !== "failed") {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return json(res, job.status === "completed" ? 200 : 202, {
          success: job.status === "completed", status: job.status, jobId: job.id,
          agents: job.events.map((event) => event.role), events: job.events,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/events") {
        const payload = req.swarmPayload || await readJson(req);
        if (payload.status !== "passed" && payload.status !== "failed") return json(res, 400, { error: "status must be passed or failed" });
        if (!executorPublicKeyPem || !executorId) return json(res, 503, { error: "pinned Grok Bot evidence verification key is not configured" });
        try {
          verifySignedEvidence({
            evidence: payload.evidence,
            signature: payload.evidence_signature,
            publicKeyPem: executorPublicKeyPem,
            expectedJobId: payload.jobId,
            expectedRole: payload.role,
            expectedExecutor: executorId,
          });
        } catch (error) {
          return json(res, 403, { error: "invalid signed specialist execution evidence" });
        }
        const expectedStatus = payload.evidence.status === "succeeded" ? "passed" : "failed";
        if (payload.status !== expectedStatus) return json(res, 409, { error: "event status does not match signed execution evidence" });
        const outcome = await serializeMutation(async () => {
          const job = jobs.get(payload.jobId);
          if (!job) return { status: 404, body: { error: "unknown job" } };
          if (job.status === "completed" || job.status === "failed") return { status: 409, body: { error: "job is terminal" } };
          const expectedRole = job.chain[job.step];
          if (payload.role !== expectedRole) return { status: 409, body: { error: "role is not next in chain", expectedRole } };
          if (payload.status !== "passed" && payload.status !== "failed") return { status: 400, body: { error: "status must be passed or failed" } };
          if (job.events.some((event) => event.role === payload.role)) return { status: 409, body: { error: "role already reported" } };
          const lease = job.lease;
          if (!lease || lease.role !== payload.role || typeof payload.claimToken !== "string" || lease.claimToken !== payload.claimToken) return { status: 403, body: { error: "active specialist claim required" } };
          if (Number(lease.expiresAt) <= now()) return { status: 409, body: { error: "specialist claim expired" } };
          const next = structuredClone(job);
          delete next.lease;
          const note = typeof payload.note === "string" ? payload.note.slice(0, 500) : "";
          next.events.push({
            role: payload.role,
            status: payload.status,
            note,
            evidence: payload.evidence,
            evidence_signature: payload.evidence_signature,
            at: new Date().toISOString(),
          });
          if (payload.status === "failed") next.status = "failed";
          else if (next.step < ROLES.length - 1) {
            next.step += 1;
            next.status = "running";
          } else next.status = "completed";
          await persist({ type: "job", job: next });
          jobs.set(next.id, next);
          return { status: 200, body: next };
        });
        return json(res, outcome.status, outcome.body);
      }
      if (req.method === "GET" && url.pathname === "/api/runner/jobs") return json(res, 200, { jobs: [...runnerJobs.values()] });
      if (req.method === "POST" && url.pathname === "/api/runner/jobs") {
        const payload = await readJson(req);
        const kind = typeof payload.kind === "string" ? payload.kind : "prove-success";
        if (!RUNNER_KINDS.has(kind)) return json(res, 400, { error: "runner kind not allowlisted" });
        const objective = payload.objective ?? payload.query ?? "";
        if (typeof objective !== "string" || objective.length > MAX_OBJECTIVE) return json(res, 400, { error: "invalid objective" });
        const id = `run-${runSeq++}`;
        const job = { id, kind, query: String(payload.query || "").slice(0, 80), objective: objective.slice(0, MAX_OBJECTIVE), status: "queued", createdAt: new Date().toISOString() };
        await persist({ type: "runner-job", job });
        runnerJobs.set(id, job);
        runnerQueue.push(id);
        return json(res, 202, job);
      }
      if (req.method === "POST" && url.pathname === "/api/runner/claim") {
        const payload = await readJson(req);
        if (typeof payload.runner !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(payload.runner)) return json(res, 400, { error: "valid runner name required" });
        const outcome = await serializeMutation(async () => {
          const now = Date.now();
          for (const candidate of runnerJobs.values()) {
            if (candidate.status === "running" && Number(candidate.leaseExpiresAt) <= now) {
              const requeued = { ...candidate, status: "queued" };
              delete requeued.runner;
              delete requeued.claimToken;
              delete requeued.claimedAt;
              delete requeued.leaseExpiresAt;
              await persist({ type: "runner-job", job: requeued });
              runnerJobs.set(requeued.id, requeued);
              runnerQueue.push(requeued.id);
            }
          }
          const id = runnerQueue.shift();
          if (!id) return null;
          const job = runnerJobs.get(id);
          if (!job || job.status !== "queued") return { status: 409, body: { error: "queue state inconsistent" } };
          const claimed = { ...job, status: "running", runner: payload.runner, claimToken: randomUUID(), claimedAt: new Date().toISOString(), leaseExpiresAt: Date.now() + 30000 };
          try { await persist({ type: "runner-job", job: claimed }); }
          catch (error) { runnerQueue.unshift(id); throw error; }
          runnerJobs.set(id, claimed);
          return { status: 200, body: claimed };
        });
        if (!outcome) { res.writeHead(204); return res.end(); }
        return json(res, outcome.status, outcome.body);
      }
      if (req.method === "POST" && url.pathname === "/api/runner/complete") {
        const payload = await readJson(req);
        const outcome = await serializeMutation(async () => {
          const job = runnerJobs.get(payload.id);
          if (!job) return { status: 404, body: { error: "unknown runner job" } };
          if (job.status !== "running") return { status: 409, body: { error: "runner job is not active" } };
          if (payload.runner !== job.runner || payload.claimToken !== job.claimToken) return { status: 403, body: { error: "runner claim does not match" } };
          if (typeof payload.ok !== "boolean") return { status: 400, body: { error: "ok boolean required" } };
          const completed = { ...job, status: payload.ok ? "completed" : "failed", note: typeof payload.note === "string" ? payload.note.slice(0, 500) : "", completedAt: new Date().toISOString() };
          if (Array.isArray(payload.hits)) completed.hits = payload.hits.slice(0, 20);
          if (payload.spawned && typeof payload.spawned === "object" && !Array.isArray(payload.spawned)) completed.spawned = payload.spawned;
          await persist({ type: "runner-job", job: completed });
          runnerJobs.set(job.id, completed);
          return { status: 200, body: completed };
        });
        return json(res, outcome.status, outcome.body);
      }
      if (req.method === "GET" && url.pathname === "/api/search") {
        const q = (url.searchParams.get("q") || "").toLowerCase();
        if (q.length < 2 || q.length > 80) return json(res, 400, { error: "q must be 2..80 chars" });
        const hits = [];
        for (const job of jobs.values()) if (`${job.id} ${job.objective} ${job.status}`.toLowerCase().includes(q)) hits.push({ type: "swarm", id: job.id, status: job.status, objective: job.objective });
        for (const job of runnerJobs.values()) if (`${job.id} ${job.kind} ${job.query || ""} ${job.note || ""}`.toLowerCase().includes(q)) hits.push({ type: "runner", id: job.id, kind: job.kind, status: job.status });
        return json(res, 200, { q, hits: hits.slice(0, 20) });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, Number.isInteger(error.status) ? error.status : 500, { error: error.status ? error.message : "internal server error" });
    }
  });
  server.stateDir = stateDir;
  server.requestTimeout = 10000;
  server.headersTimeout = 12000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen(PORT, () => console.log(`coordinator listening on ${PORT} tenant=${TENANT}`));
}
