import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson, digestJson, verifySignedReceipt } from "./integration-contract.js";
import { authorizeAndEnqueue } from "./integration-adapter.js";

const issuerKeys = generateKeyPairSync("ed25519");
const caKeys = generateKeyPairSync("ed25519");
const receiptKeys = generateKeyPairSync("ed25519");
const b64 = (value) => Buffer.from(value).toString("base64");
const signObject = (value, key) => b64(sign(null, Buffer.from(canonicalJson(value)), key));
const rawCaKey = caKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const issuer = "spiffe://prod/agent/avrone";
const audience = "spiffe://prod/agent/swarm";
const trust = {
  avroneIssuerPublicKeyPem: issuerKeys.publicKey.export({ type: "spki", format: "pem" }),
  avroneIssuer: issuer,
  swarmAudience: audience,
  capabilityAuthorityPublicKeyB64: rawCaKey,
  capabilityAuthorityIssuer: "spiffe://prod/broker",
  swarmReceiptPrivateKeyPem: receiptKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
};

function requestFor(payload = { objective: "run debugger, coder, tester, governance", action: { type: "Execute", resource: "swarm.jobs", method: "POST" } }) {
  const now = Date.now();
  const capability = {
    id: "cap-42", issuer: trust.capabilityAuthorityIssuer, audience,
    rights: [{ type: "Execute", resource: "swarm.jobs", method: "POST" }], constraints: {},
    issued_at: now / 1000, expires_at: (now + 60000) / 1000,
  };
  const unsigned = {
    schema: "avrone.message-envelope/v1", message_id: "message-42", correlation_id: "correlation-42",
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString(),
    issuer, audience, capability_id: capability.id, payload_digest: digestJson(payload),
  };
  return {
    envelope: { ...unsigned, signature: signObject(unsigned, issuerKeys.privateKey) },
    payload, capability, capability_signature: signObject(capability, caKeys.privateKey),
  };
}

test("authorizes signed cross-repo request and returns verifiable receipt after durable commit", async () => {
  let committed;
  const result = await authorizeAndEnqueue({
    request: requestFor(), trust, nowMs: Date.now(),
    commit: async (record) => { committed = record; return { job: { id: "job-1", status: "queued", objective: record.objective }, durable: true }; },
  });
  assert.equal(committed.objective, "run debugger, coder, tester, governance");
  assert.equal(result.job.id, "job-1");
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.action, "Execute:swarm.jobs:POST");
  assert.equal(verifySignedReceipt({ receipt: result.receipt, publicKeyPem: receiptKeys.publicKey.export({ type: "spki", format: "pem" }) }), true);
});

test("rejects tampering, capability mismatch, method substitution and bad objective before commit", async () => {
  let commits = 0;
  const commit = async () => { commits += 1; return { job: { id: "bad" } }; };
  const tampered = requestFor(); tampered.payload.objective = "altered";
  await assert.rejects(authorizeAndEnqueue({ request: tampered, trust, commit }), /digest mismatch/);
  const wrongCap = requestFor();
  const alteredEnvelope = { ...wrongCap.envelope, capability_id: "another-cap" };
  delete alteredEnvelope.signature;
  wrongCap.envelope = { ...alteredEnvelope, signature: signObject(alteredEnvelope, issuerKeys.privateKey) };
  await assert.rejects(authorizeAndEnqueue({ request: wrongCap, trust, commit }), /capability_id does not match/);
  const wrongMethod = requestFor(); wrongMethod.payload.action.method = "DELETE";
  const changedMethodEnvelope = { ...wrongMethod.envelope, payload_digest: digestJson(wrongMethod.payload) };
  delete changedMethodEnvelope.signature;
  wrongMethod.envelope = { ...changedMethodEnvelope, signature: signObject(changedMethodEnvelope, issuerKeys.privateKey) };
  await assert.rejects(authorizeAndEnqueue({ request: wrongMethod, trust, commit }), /does not authorize exact/);
  const empty = requestFor({ objective: "   ", action: { type: "Execute", resource: "swarm.jobs", method: "POST" } });
  await assert.rejects(authorizeAndEnqueue({ request: empty, trust, commit }), /objective/);
  assert.equal(commits, 0);
});

test("refuses success when durable commit fails or does not return a persisted job", async () => {
  await assert.rejects(authorizeAndEnqueue({ request: requestFor(), trust, commit: async () => { throw new Error("fsync failed"); } }), /fsync failed/);
  await assert.rejects(authorizeAndEnqueue({ request: requestFor(), trust, commit: async () => ({}) }), /durable commit did not return a job/);
});
