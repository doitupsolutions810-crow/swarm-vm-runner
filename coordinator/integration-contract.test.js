import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson, digestJson, verifyEnvelope, verifyCapability, createSignedReceipt, verifySignedReceipt } from "./integration-contract.js";

const issuerKeys = generateKeyPairSync("ed25519");
const capabilityKeys = generateKeyPairSync("ed25519");
const receiptKeys = generateKeyPairSync("ed25519");
const publicRawB64 = capabilityKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const b64 = (data) => Buffer.from(data).toString("base64");
const signed = (value, key) => b64(sign(null, Buffer.from(canonicalJson(value)), key));
const issuer = "spiffe://prod/agent/avrone";
const audience = "spiffe://prod/agent/swarm";

function makeEnvelope(payload, overrides = {}) {
  const now = Date.now();
  const unsigned = {
    schema: "avrone.message-envelope/v1", message_id: "message-001", correlation_id: "correlation-001",
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString(),
    issuer, audience, capability_id: "cap-001", payload_digest: digestJson(payload), ...overrides,
  };
  return { ...unsigned, signature: signed(unsigned, issuerKeys.privateKey) };
}

function makeCapability(overrides = {}) {
  const now = Date.now();
  const capability = {
    id: "cap-001", issuer: "spiffe://prod/broker", audience,
    rights: [{ type: "Execute", resource: "swarm.jobs", method: "POST" }], constraints: {},
    issued_at: now / 1000, expires_at: (now + 60000) / 1000, trust_domain: "prod", ...overrides,
  };
  return { capability, signature: signed(capability, capabilityKeys.privateKey) };
}

const receiptFields = (overrides = {}) => ({
  message_id: "message-001", correlation_id: "correlation-001", capability_id: "cap-001",
  issuer, executor: audience, action: "Execute:swarm.jobs:POST", resource: "swarm.jobs",
  method: "POST", outcome: "succeeded", timestamp: new Date().toISOString(),
  payload_digest: `sha256:${"a".repeat(64)}`, previous_receipt_digest: null, ...overrides,
});

test("canonical JSON and digest are deterministic and reject unsafe values", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.equal(digestJson({ a: 1, b: 2 }), digestJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson("München 東京 🚀"), '"München 東京 🚀"');
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
  assert.equal(canonicalJson({ small: 1e-7, large: 1e21, negativeZero: -0, integerFloat: 1.0 }), '{"integerFloat":1,"large":1e+21,"negativeZero":0,"small":1e-7}');
  assert.throws(() => canonicalJson("\\ud800"), /unpaired Unicode surrogate/);
  const unsafe = JSON.parse('{"__proto__":"x"}');
  assert.throws(() => canonicalJson(unsafe), /unsafe object key/);
});

test("verifies signed AVRONE envelope against pinned issuer key and payload digest", () => {
  const payload = { objective: "run integration test", task: { name: "test" } };
  const envelope = makeEnvelope(payload);
  const publicKeyPem = issuerKeys.publicKey.export({ type: "spki", format: "pem" });
  assert.equal(verifyEnvelope({ envelope, payload, publicKeyPem, expectedIssuer: issuer, expectedAudience: audience }).messageId, "message-001");
});

test("rejects payload, signature, issuer, audience and schema substitution", () => {
  const payload = { objective: "approved" };
  const envelope = makeEnvelope(payload);
  const args = { publicKeyPem: issuerKeys.publicKey.export({ type: "spki", format: "pem" }), expectedIssuer: issuer, expectedAudience: audience };
  assert.throws(() => verifyEnvelope({ ...args, envelope, payload: { objective: "tampered" } }), /digest mismatch/);
  assert.throws(() => verifyEnvelope({ ...args, envelope: { ...envelope, issuer: "spiffe://evil/issuer" }, payload }), /issuer or audience mismatch/);
  assert.throws(() => verifyEnvelope({ ...args, envelope: { ...envelope, audience: "other" }, payload }), /issuer or audience mismatch/);
  assert.throws(() => verifyEnvelope({ ...args, envelope: { ...envelope, extra: true }, payload }), /fields do not match/);
  assert.throws(() => verifyEnvelope({ ...args, envelope: { ...envelope, signature: b64(Buffer.alloc(64)) }, payload }), /invalid envelope signature/);
});

test("rejects expired, premature and overlong envelopes", () => {
  const payload = { ok: true }, now = Date.now();
  const base = { schema: "avrone.message-envelope/v1", message_id: "m", correlation_id: "c", issuer, audience, capability_id: "cap-001", payload_digest: digestJson(payload) };
  for (const [issued, expires] of [[now - 120000, now - 60000], [now + 120000, now + 180000], [now, now + 600000]]) {
    const unsigned = { ...base, issued_at: new Date(issued).toISOString(), expires_at: new Date(expires).toISOString() };
    const envelope = { ...unsigned, signature: signed(unsigned, issuerKeys.privateKey) };
    assert.throws(() => verifyEnvelope({ envelope, payload, publicKeyPem: issuerKeys.publicKey.export({ type: "spki", format: "pem" }), expectedIssuer: issuer, expectedAudience: audience }), /expired, premature, or exceeds/);
  }
});

test("verifies capability signature and exact action/resource/method/audience", () => {
  const { capability, signature } = makeCapability();
  const args = { capability, signature, publicKeyB64: publicRawB64, expectedIssuer: "spiffe://prod/broker", expectedAudience: audience, action: { type: "Execute", resource: "swarm.jobs", method: "POST" } };
  assert.equal(verifyCapability(args).capabilityId, "cap-001");
  assert.throws(() => verifyCapability({ ...args, action: { ...args.action, method: "DELETE" } }), /does not authorize exact/);
  assert.throws(() => verifyCapability({ ...args, expectedAudience: "spiffe://prod/agent/other" }), /issuer, id, or audience mismatch/);
  assert.throws(() => verifyCapability({ ...args, capability: { ...capability, expires_at: Date.now() / 1000 - 1 } }), /expired, premature/);
  assert.throws(() => verifyCapability({ ...args, capability: { ...capability, issued_at: true } }), /timestamps must be numbers/);
  assert.throws(() => verifyCapability({ ...args, signature: b64(Buffer.alloc(64)) }), /invalid capability signature/);
});

test("creates signed receipt and detects tampering and schema drift", () => {
  const privateKeyPem = receiptKeys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = receiptKeys.publicKey.export({ type: "spki", format: "pem" });
  const receipt = createSignedReceipt({ fields: receiptFields(), privateKeyPem });
  assert.equal(verifySignedReceipt({ receipt, publicKeyPem }), true);
  assert.throws(() => verifySignedReceipt({ receipt: { ...receipt, outcome: "authorized_not_executed" }, publicKeyPem }), /invalid receipt signature/);
  assert.throws(() => createSignedReceipt({ fields: receiptFields({ previous_receipt_digest: "bad" }), privateKeyPem }), /invalid previous receipt digest/);
  assert.throws(() => createSignedReceipt({ fields: receiptFields({ method: "delete" }), privateKeyPem }), /method must be uppercase/);
  assert.throws(() => verifySignedReceipt({ receipt: { ...receipt, unrecognized: true }, publicKeyPem }), /fields do not match/);
});
