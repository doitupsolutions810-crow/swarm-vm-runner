import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "./server.js";
import { canonicalJson, digestJson, verifySignedReceipt } from "./integration-contract.js";

const API_TOKEN = "integration-test-api-token-0123456789abcdef";
const readToken = "integration-test-read-token-0123456789abcdef";
const runnerToken = "integration-test-runner-token-0123456789abcdef";
const roleTokens = Object.fromEntries(["debugger", "coder", "tester", "governance"].map((role) => [role, `integration-role-${role}-token-0123456789abcdef`]));
const issuerKeys = generateKeyPairSync("ed25519");
const caKeys = generateKeyPairSync("ed25519");
const receiptKeys = generateKeyPairSync("ed25519");
const issuer = "spiffe://prod/agent/avrone";
const audience = "spiffe://prod/agent/swarm";
const b64 = (value) => Buffer.from(value).toString("base64");
const signObject = (value, key) => b64(sign(null, Buffer.from(canonicalJson(value)), key));
const trust = {
  avroneIssuerPublicKeyPem: issuerKeys.publicKey.export({ type: "spki", format: "pem" }),
  avroneIssuer: issuer,
  swarmAudience: audience,
  capabilityAuthorityPublicKeyB64: caKeys.publicKey.export({ type: "der", format: "spki" }).subarray(-32).toString("base64"),
  capabilityAuthorityIssuer: "spiffe://prod/broker",
  swarmReceiptPrivateKeyPem: receiptKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
};

function makeRequest(payload = { objective: "execute the four specialist roles", action: { type: "Execute", resource: "swarm.jobs", method: "POST" } }) {
  const now = Date.now();
  const capability = {
    id: "cap-integration-1", issuer: trust.capabilityAuthorityIssuer, audience,
    rights: [{ type: "Execute", resource: "swarm.jobs", method: "POST" }], constraints: {},
    issued_at: now / 1000, expires_at: (now + 60000) / 1000,
  };
  const unsigned = {
    schema: "avrone.message-envelope/v1", message_id: "message-integration-1", correlation_id: "correlation-integration-1",
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString(),
    issuer, audience, capability_id: capability.id, payload_digest: digestJson(payload),
  };
  return {
    envelope: { ...unsigned, signature: signObject(unsigned, issuerKeys.privateKey) },
    payload, capability, capability_signature: signObject(capability, caKeys.privateKey),
  };
}

async function start(stateDir, compactAfterRecords = 500) {
  const server = createServer({
    token: API_TOKEN, readToken, runnerToken, roleTokens, stateDir,
    tenant: "integration-test", compactAfterRecords, ...trust,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function stop(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function post(base, body) {
  const response = await fetch(`${base}/api/integration/enqueue`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("signed enqueue persists job and receipt; exact retry returns original result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-signed-enqueue-"));
  const first = await start(dir);
  const request = makeRequest();
  try {
    const accepted = await post(first.base, request);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.job.status, "queued");
    assert.equal(accepted.body.receipt.outcome, "succeeded");
    assert.equal(verifySignedReceipt({ receipt: accepted.body.receipt, publicKeyPem: receiptKeys.publicKey.export({ type: "spki", format: "pem" }) }), true);
    const replay = await post(first.base, request);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(replay.body.job.id, accepted.body.job.id);
    assert.deepEqual(replay.body.receipt, accepted.body.receipt);
    const jobs = await fetch(`${first.base}/api/jobs`, { headers: { authorization: `Bearer ${readToken}` } }).then((r) => r.json());
    assert.equal(jobs.jobs.filter((job) => job.id === accepted.body.job.id).length, 1);
  } finally {
    await stop(first.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("conflicting reuse of message or correlation id is rejected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-signed-conflict-"));
  const instance = await start(dir);
  try {
    const first = makeRequest();
    const accepted = await post(instance.base, first);
    assert.equal(accepted.status, 202);
    const alteredPayload = { objective: "different operation under same id" };
    const conflict = makeRequest(alteredPayload);
    const changed = { ...conflict.envelope, message_id: first.envelope.message_id, correlation_id: first.envelope.correlation_id };
    delete changed.signature;
    conflict.envelope = { ...changed, signature: signObject(changed, issuerKeys.privateKey) };
    const rejected = await post(instance.base, conflict);
    assert.equal(rejected.status, 409);
  } finally {
    await stop(instance.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("method substitution is rejected before job persistence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-signed-method-"));
  const instance = await start(dir);
  try {
    const request = makeRequest();
    request.payload.action.method = "DELETE";
    const changed = { ...request.envelope, payload_digest: digestJson(request.payload) };
    delete changed.signature;
    request.envelope = { ...changed, signature: signObject(changed, issuerKeys.privateKey) };
    const rejected = await post(instance.base, request);
    assert.equal(rejected.status, 403);
    const jobs = await fetch(`${instance.base}/api/jobs`, { headers: { authorization: `Bearer ${readToken}` } }).then((r) => r.json());
    assert.equal(jobs.jobs.length, 0);
  } finally {
    await stop(instance.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signed receipt idempotency ledger survives compaction and restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-signed-restart-"));
  const request = makeRequest();
  const first = await start(dir, 1);
  let accepted;
  try {
    accepted = await post(first.base, request);
    assert.equal(accepted.status, 202);
    await stop(first.server);
    const second = await start(dir, 1);
    try {
      const replay = await post(second.base, request);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.idempotent_replay, true);
      assert.deepEqual(replay.body.receipt, accepted.body.receipt);
    } finally {
      await stop(second.server);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
