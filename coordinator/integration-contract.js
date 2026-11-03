import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

const ENVELOPE_FIELDS = ["schema", "message_id", "correlation_id", "issued_at", "expires_at", "issuer", "audience", "capability_id", "payload_digest", "signature"];
const RECEIPT_FIELDS = ["message_id", "correlation_id", "capability_id", "issuer", "executor", "action", "resource", "method", "outcome", "timestamp", "payload_digest", "previous_receipt_digest", "signature"];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RAW_ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function assertWellFormedUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("unpaired Unicode surrogate");
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("unpaired Unicode surrogate");
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalJson(value) {
  if (typeof value === "string") { assertWellFormedUnicode(value); return JSON.stringify(value); }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw new TypeError("only plain JSON objects are canonicalizable");
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    assertWellFormedUnicode(key);
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new TypeError("unsafe object key");
    if (value[key] === undefined) throw new TypeError("undefined object value");
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function digestJson(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function exactKeys(value, fields) {
  return isPlainObject(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function validText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeSignature(value) {
  if (typeof value !== "string" || !B64.test(value)) throw new Error("signature must be canonical base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) throw new Error("signature must be a 64-byte Ed25519 signature");
  return bytes;
}

function verifyWithPem(unsigned, signature, publicKeyPem) {
  if (typeof publicKeyPem !== "string" || !publicKeyPem.includes("BEGIN PUBLIC KEY")) throw new Error("pinned issuer public key is not configured");
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("pinned issuer key must be Ed25519");
  return cryptoVerify(null, Buffer.from(canonicalJson(unsigned)), key, decodeSignature(signature));
}

function verifyWithRawEd25519(unsigned, signature, publicKeyB64) {
  if (typeof publicKeyB64 !== "string" || !B64.test(publicKeyB64)) throw new Error("pinned capability-authority key is not configured");
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== publicKeyB64) throw new Error("pinned capability-authority key must be 32-byte base64");
  const key = createPublicKey({ key: Buffer.concat([RAW_ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  return cryptoVerify(null, Buffer.from(canonicalJson(unsigned)), key, decodeSignature(signature));
}

export function verifyEnvelope({ envelope, payload, publicKeyPem, expectedIssuer, expectedAudience, nowMs = Date.now(), maxLifetimeMs = 300000, clockSkewMs = 30000 }) {
  if (!exactKeys(envelope, ENVELOPE_FIELDS)) throw new Error("envelope fields do not match avrone.message-envelope/v1");
  if (envelope.schema !== "avrone.message-envelope/v1") throw new Error("unsupported envelope schema");
  for (const field of ["message_id", "correlation_id", "issuer", "audience", "capability_id"]) {
    if (!validText(envelope[field])) throw new Error(`envelope.${field} is required`);
  }
  if (envelope.issuer !== expectedIssuer || envelope.audience !== expectedAudience) throw new Error("envelope issuer or audience mismatch");
  if (!DIGEST.test(envelope.payload_digest)) throw new Error("invalid payload digest format");
  if (digestJson(payload) !== envelope.payload_digest) throw new Error("payload digest mismatch");
  const issued = Date.parse(envelope.issued_at);
  const expires = Date.parse(envelope.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || new Date(issued).toISOString() !== envelope.issued_at || new Date(expires).toISOString() !== envelope.expires_at) {
    throw new Error("issued_at and expires_at must be canonical UTC date-time strings");
  }
  if (issued > nowMs + clockSkewMs || expires <= nowMs || expires <= issued || expires - issued > maxLifetimeMs) throw new Error("envelope is expired, premature, or exceeds maximum lifetime");
  const unsigned = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "signature"));
  if (!verifyWithPem(unsigned, envelope.signature, publicKeyPem)) throw new Error("invalid envelope signature");
  return { messageId: envelope.message_id, correlationId: envelope.correlation_id, payloadDigest: envelope.payload_digest };
}

export function verifyCapability({ capability, signature, publicKeyB64, expectedIssuer, expectedAudience, action, nowMs = Date.now(), clockSkewMs = 30000 }) {
  if (!isPlainObject(capability)) throw new Error("capability must be an object");
  if (!validText(capability.id) || capability.issuer !== expectedIssuer || capability.audience !== expectedAudience) throw new Error("capability issuer, id, or audience mismatch");
  const issued = Number(capability.issued_at) * 1000;
  const expires = Number(capability.expires_at) * 1000;
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > nowMs + clockSkewMs || expires <= nowMs || expires <= issued || expires - issued > 300000) throw new Error("capability is expired, premature, or exceeds maximum lifetime");
  if (!isPlainObject(action) || !["type", "resource", "method"].every((key) => validText(action[key])) || !/^[A-Z]+$/.test(action.method)) throw new Error("action must specify exact type, resource and uppercase method");
  if (!Array.isArray(capability.rights) || !capability.rights.some((right) => isPlainObject(right) && right.type === action.type && right.resource === action.resource && right.method === action.method)) throw new Error("capability does not authorize exact action/resource/method");
  if (!isPlainObject(capability.constraints)) throw new Error("capability constraints must be an object");
  if (!verifyWithRawEd25519(capability, signature, publicKeyB64)) throw new Error("invalid capability signature");
  return { capabilityId: capability.id, action: `${action.type}:${action.resource}:${action.method}` };
}

export function createSignedReceipt({ fields, privateKeyPem }) {
  if (!exactKeys(fields, RECEIPT_FIELDS.filter((field) => field !== "signature"))) throw new Error("receipt fields do not match avrone.authorization-receipt/v1");
  if (!["authorized_not_executed", "succeeded", "failed"].includes(fields.outcome)) throw new Error("invalid receipt outcome");
  if (!DIGEST.test(fields.payload_digest)) throw new Error("invalid receipt payload digest");
  if (fields.previous_receipt_digest !== null && !DIGEST.test(fields.previous_receipt_digest)) throw new Error("invalid previous receipt digest");
  const key = createPublicKey({ key: privateKeyPem, format: "pem" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("receipt signing key must be Ed25519");
  const signature = cryptoSign(null, Buffer.from(canonicalJson(fields)), privateKeyPem).toString("base64");
  return { ...fields, signature };
}

export function verifySignedReceipt({ receipt, publicKeyPem }) {
  if (!exactKeys(receipt, RECEIPT_FIELDS)) throw new Error("receipt fields do not match avrone.authorization-receipt/v1");
  if (!["authorized_not_executed", "succeeded", "failed"].includes(receipt.outcome)) throw new Error("invalid receipt outcome");
  if (!DIGEST.test(receipt.payload_digest)) throw new Error("invalid receipt payload digest");
  const unsigned = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "signature"));
  if (!verifyWithPem(unsigned, receipt.signature, publicKeyPem)) throw new Error("invalid receipt signature");
  return true;
}
