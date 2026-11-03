import { createSignedReceipt, verifyCapability, verifyEnvelope } from "./integration-contract.js";

const ENQUEUE_ACTION = Object.freeze({ type: "Execute", resource: "swarm.jobs", method: "POST" });

export async function authorizeAndEnqueue({ request, trust, nowMs = Date.now(), previousReceiptDigest = null, commit }) {
  if (typeof commit !== "function") throw new TypeError("durable commit callback is required");
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("integration request must be an object");
  const { envelope, payload, capability, capability_signature: capabilitySignature, action } = request;
  const envelopeResult = verifyEnvelope({
    envelope, payload,
    publicKeyPem: trust.avroneIssuerPublicKeyPem,
    expectedIssuer: trust.avroneIssuer,
    expectedAudience: trust.swarmAudience,
    nowMs,
  });
  if (envelope.capability_id !== capability?.id) throw new Error("envelope capability_id does not match supplied capability");
  const capabilityResult = verifyCapability({
    capability, signature: capabilitySignature,
    publicKeyB64: trust.capabilityAuthorityPublicKeyB64,
    expectedIssuer: trust.capabilityAuthorityIssuer,
    expectedAudience: trust.swarmAudience,
    action,
    nowMs,
  });
  if (action.type !== ENQUEUE_ACTION.type || action.resource !== ENQUEUE_ACTION.resource || action.method !== ENQUEUE_ACTION.method) {
    throw new Error("only Execute:swarm.jobs:POST is currently implemented");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || typeof payload.objective !== "string" || !payload.objective.trim()
      || payload.objective.length > 2000) throw new Error("payload.objective must contain 1..2000 characters");
  const receiptFields = {
    message_id: envelope.message_id,
    correlation_id: envelope.correlation_id,
    capability_id: capability.id,
    issuer: envelope.issuer,
    executor: trust.swarmAudience,
    action: `${action.type}:${action.resource}:${action.method}`,
    resource: action.resource,
    method: action.method,
    outcome: "succeeded",
    timestamp: new Date(nowMs).toISOString(),
    payload_digest: envelope.payload_digest,
    previous_receipt_digest: previousReceiptDigest,
  };
  const receipt = createSignedReceipt({ fields: receiptFields, privateKeyPem: trust.swarmReceiptPrivateKeyPem });
  const committed = await commit({
    objective: payload.objective.trim(),
    envelope: envelopeResult,
    capability: capabilityResult,
    action: { ...action },
    receipt,
  });
  if (!committed || typeof committed !== "object" || !committed.job) throw new Error("durable commit did not return a job");
  return { ...committed, receipt };
}
