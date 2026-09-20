import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto';
import {
  verifyInclusions,
  verifyLogRecords,
  leafHash,
  payloadHash,
  safeNumber
} from './evm.js';

function requireThat(condition, code) {
  if (!condition) throw new Error(code);
}

export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);

  if (typeof value === 'string') {
    requireThat(value === value.normalize('NFC'), 'NON_CANONICAL_STRING');
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    requireThat(Number.isSafeInteger(value) && !Object.is(value, -0), 'INVALID_NUMBER');
    return String(value);
  }

  if (Array.isArray(value)) {
    const elements = value.map(canonical);
    return `[${elements.join(',')}]`;
  }

  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_JSON_VALUE');
  const sortedKeys = Object.keys(value).sort();
  const properties = sortedKeys.map(k => {
    const encodedKey = canonical(k);
    const encodedValue = canonical(value[k]);
    return `${encodedKey}:${encodedValue}`;
  });
  return `{${properties.join(',')}}`;
}

export const hash = value => {
  const digest = createHash('sha256');
  const bytes = Buffer.from(canonical(value));
  return digest.update(bytes).digest('hex');
};

export function sign(domain, payload, key) {
  const bytes = Buffer.from(canonical({ domain, payload }));
  const rawSignature = cryptoSign(null, bytes, key);
  return {
    domain,
    payload,
    signature: rawSignature.toString('base64')
  };
}

function verifySignature(envelope, domain, key) {
  requireThat(
    envelope?.domain === domain && typeof envelope.signature === 'string',
    'INVALID_ENVELOPE'
  );
  const envelopeFields = Object.keys(envelope).sort().join(',');
  requireThat(envelopeFields === 'domain,payload,signature', 'INVALID_ENVELOPE');

  const raw = Buffer.from(envelope.signature, 'base64');
  requireThat(
    raw.length === 64 && raw.toString('base64') === envelope.signature,
    'INVALID_SIGNATURE_ENCODING'
  );
  const signedBytes = Buffer.from(canonical({ domain, payload: envelope.payload }));
  const validSignature = cryptoVerify(null, signedBytes, key, raw);
  requireThat(validSignature, 'INVALID_SIGNATURE');

  return envelope.payload;
}

function assertFields(object, keys) {
  requireThat(
    object && Object.getPrototypeOf(object) === Object.prototype,
    'INVALID_SCHEMA'
  );
  const actualFields = canonical(Object.keys(object).sort());
  const expectedFields = canonical([...keys].sort());
  requireThat(actualFields === expectedFields, 'INVALID_SCHEMA');
}

export function validatePolicy(policy) {
  assertFields(policy, ['version', 'id', 'institution', 'currency', 'limit', 'decisionWindow']);
  requireThat(
    policy.version === 1
    && policy.id === 'per-transfer-limit-v1'
    && policy.institution === 'demo-bank'
    && policy.currency === 'KRW'
    && policy.limit === 1000000
    && policy.decisionWindow === 60,
    'UNSUPPORTED_POLICY'
  );
}

export function verifyRequestEnvelope(envelope, verificationContext) {
  const r = verifySignature(envelope, 'request', verificationContext.customerKey);
  assertFields(r, ['version', 'id', 'customer', 'institution', 'amount', 'currency', 'policyHash']);
  requireThat(
    r.version === 1
    && typeof r.id === 'string'
    && /^[a-zA-Z0-9_-]{1,100}$/.test(r.id),
    'INVALID_REQUEST'
  );
  requireThat(
    r.customer === 'demo-customer'
    && r.institution === verificationContext.policy.institution
    && r.currency === 'KRW'
    && r.policyHash === hash(verificationContext.policy),
    'REQUEST_CONTEXT_MISMATCH'
  );
  requireThat(Number.isSafeInteger(r.amount) && r.amount > 0, 'INVALID_AMOUNT');

  return r;
}

export function evaluateRequest(r) {
  return r.amount > 1000000
    ? { outcome: 'REJECTED', reason: 'LIMIT_EXCEEDED' }
    : { outcome: 'APPROVED', reason: 'WITHIN_LIMIT' };
}

export function createRequest({ id, amount, policy, customerPrivateKey }) {
  const policySnapshot = structuredClone(policy);
  validatePolicy(policySnapshot);
  const payload = {
    version: 1,
    id,
    customer: 'demo-customer',
    institution: policySnapshot.institution,
    amount,
    currency: 'KRW',
    policyHash: hash(policySnapshot)
  };
  const envelope = sign('request', payload, customerPrivateKey);
  verifyRequestEnvelope(envelope, {
    policy: policySnapshot,
    customerKey: createPublicKey(customerPrivateKey)
  });
  return structuredClone(envelope);
}

export function verifyDecisionEnvelope(envelope, request, verificationContext) {
  const d = verifySignature(envelope, 'decision', verificationContext.institutionKey);
  assertFields(d, ['version', 'requestHash', 'policyHash', 'outcome', 'reason']);
  requireThat(
    d.version === 1
    && d.requestHash === hash(request)
    && d.policyHash === hash(verificationContext.policy),
    'DECISION_CONTEXT_MISMATCH'
  );

  const expected = evaluateRequest(request.payload);
  requireThat(d.outcome === expected.outcome && d.reason === expected.reason, 'POLICY_MISMATCH');
  return d;
}

export const encodePayload = envelope => {
  const bytes = Buffer.from(canonical(envelope), 'utf8');
  return `0x${bytes.toString('hex')}`;
};

export function decodePayload(bytes, record) {
  requireThat(bytes !== null && bytes !== undefined, 'MISSING_PAYLOAD');
  requireThat(payloadHash(bytes) === record.payloadHash.toLowerCase(), 'PAYLOAD_HASH_MISMATCH');

  let envelope;

  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const payloadBytes = Buffer.from(bytes.slice(2), 'hex');
    const json = decoder.decode(payloadBytes);
    envelope = JSON.parse(json);
  } catch {
    throw new Error('INVALID_PAYLOAD');
  }

  requireThat(envelope && typeof envelope === 'object', 'INVALID_ENVELOPE');
  const envelopeFields = Object.keys(envelope).sort().join(',');
  requireThat(envelopeFields === 'domain,payload,signature', 'INVALID_ENVELOPE');
  return envelope;
}

function verifyRequestEvidence(bundle, verificationContext) {
  requireThat(bundle?.request, 'MISSING_EVIDENCE');
  const inclusion = {
    entry: bundle.request.entry?.record,
    proof: bundle.request.proof
  };
  const { entries: records } = verifyInclusions([inclusion], bundle.checkpointId, verificationContext);
  const [record] = records;
  requireThat(record.kind === 0n, 'EXPECTED_REQUEST');
  const envelope = decodePayload(bundle.request.entry.payloadBytes, record);
  const r = verifyRequestEnvelope(envelope, verificationContext);
  return { record, envelope, request: r };
}

export function verifyReceipt(bundle, verificationContext) {
  const { record, request: r } = verifyRequestEvidence(bundle, verificationContext);
  return { ok: true, requestId: r.id, index: safeNumber(record.index) };
}

export function verifySingle(bundle, verificationContext) {
  requireThat(bundle?.request && bundle.decision, 'MISSING_EVIDENCE');
  const items = [bundle.request, bundle.decision];
  const inclusions = items.map(item => ({ entry: item.entry?.record, proof: item.proof }));
  const { entries: records } = verifyInclusions(inclusions, bundle.checkpointId, verificationContext);
  const [requestRecord, decisionRecord] = records;
  const [requestEnvelope, decisionEnvelope] = items.map((item, index) =>
    decodePayload(item.entry.payloadBytes, records[index]));

  requireThat(
    requestRecord.kind === 0n
    && decisionRecord.kind === 1n
    && decisionRecord.requestIndex === requestRecord.index,
    'DECISION_LINK_MISMATCH'
  );

  const r = verifyRequestEnvelope(requestEnvelope, verificationContext);
  const d = verifyDecisionEnvelope(decisionEnvelope, requestEnvelope, verificationContext);
  requireThat(
    requestRecord.recordedAt <= decisionRecord.recordedAt,
    'INVALID_EVENT_ORDER'
  );

  return {
    ok: true,
    requestId: r.id,
    amount: r.amount,
    outcome: d.outcome,
    reason: d.reason
  };
}

export function audit(entries, verificationContext) {
  requireThat(Array.isArray(entries), 'LOG_SIZE_MISMATCH');
  const rawRecords = entries.map(entry => entry.record);
  const { checkpointInfo: info, entries: records } = verifyLogRecords(rawRecords, verificationContext);

  const requests = new Map();
  const reqIds = new Set();
  const decisions = new Set();

  entries.forEach((entry, index) => {
    const record = records[index];
    const envelope = decodePayload(entry.payloadBytes, record);

    if (record.kind === 0n) {
      requireThat(record.actor.toLowerCase() === verificationContext.institutionAddress.toLowerCase(), 'ACTOR_MISMATCH');
      const r = verifyRequestEnvelope(envelope, verificationContext);
      requireThat(!reqIds.has(r.id), 'DUPLICATE_REQUEST');
      reqIds.add(r.id);
      requests.set(record.index, { record, envelope });
    } else {
      const key = record.requestIndex;
      verifyDecisionEnvelope(envelope, requests.get(key).envelope, verificationContext);
      decisions.add(key);
    }
  });

  const pending = [];
  const overdue = [];
  for (const [key, request] of requests) {
    if (decisions.has(key)) continue;

    const deadline = request.record.recordedAt + BigInt(verificationContext.policy.decisionWindow);
    const id = request.envelope.payload.id;
    if (info.checkpoint.issuedAt >= deadline) {
      overdue.push(id);
    } else {
      pending.push(id);
    }
  }

  return {
    ok: overdue.length === 0,
    requests: requests.size,
    decisions: decisions.size,
    pending,
    overdue
  };
}

export function buildBundle(entries, request, decision, verificationContext) {
  const list = entries.slice(0, safeNumber(verificationContext.checkpoint.size));
  const rawRecords = list.map(entry => entry.record);
  const { checkpointInfo: info, tree } = verifyLogRecords(rawRecords, verificationContext);
  const item = (candidate, kind) => {
    requireThat(candidate?.record, 'MISSING_EVIDENCE');
    const index = safeNumber(candidate.record.index);
    const entry = list[index];
    requireThat(
      entry && BigInt(entry.record.kind) === kind,
      'EVIDENCE_NOT_IN_CHECKPOINT'
    );
    const candidateHash = leafHash(candidate.record, verificationContext);
    const storedHash = leafHash(entry.record, verificationContext);
    requireThat(candidateHash === storedHash, 'EVIDENCE_NOT_IN_CHECKPOINT');
    const { payloadBytes, record, checkpointId } = entry;
    return { entry: { payloadBytes, record, checkpointId }, proof: tree.proof(index) };
  };

  const result = {
    checkpointId: info.checkpointId,
    request: item(request, 0n)
  };
  if (decision !== undefined) result.decision = item(decision, 1n);
  return structuredClone(result);
}

export function createInstitution({
  logClient,
  policy,
  institutionKeys,
  customerKey,
  onPayload = () => { },
  onAppend = () => { }
}) {
  const policySnapshot = structuredClone(policy);
  validatePolicy(policySnapshot);
  requireThat(typeof customerKey === 'string', 'INVALID_CUSTOMER_KEY');
  requireThat(institutionKeys?.publicKey && institutionKeys.privateKey, 'INVALID_INSTITUTION_KEYS');
  const institutionPrivateKey = institutionKeys.privateKey;
  const entries = [];
  const baseVerificationContext = {
    chainId: logClient.context.chainId,
    evidenceLogAddress: logClient.context.evidenceLogAddress,
    depth: logClient.context.depth,
    institutionAddress: logClient.context.institutionAddress,
    policy: policySnapshot,
    customerKey,
    institutionKey: institutionKeys.publicKey.export({ type: 'spki', format: 'pem' })
  };

  function withRegistration(error, registration) {
    const snapshot = structuredClone(registration);
    error.txHash ??= snapshot.txHash;
    error.registration = snapshot;
    return error;
  }

  async function register(evidence, send) {
    const envelopeSnapshot = structuredClone(evidence);
    const bytes = encodePayload(envelopeSnapshot);
    await onPayload(bytes, structuredClone(envelopeSnapshot));

    const registration = structuredClone(await send(bytes));
    try {
      const record = registration.entry;
      const entry = {
        payloadBytes: bytes,
        record,
        checkpointId: registration.checkpointId
      };
      const updatedEntries = [...entries, entry];
      const entriesSnapshot = structuredClone(updatedEntries);
      await onAppend(entriesSnapshot);
      entries.push(entry);
      return { entry: structuredClone(entry), registration };
    } catch (error) {
      throw withRegistration(error, registration);
    }
  }

  async function accept(envelope) {
    envelope = structuredClone(envelope);
    const request = verifyRequestEnvelope(envelope, baseVerificationContext);

    const hasDuplicateRequest = entries.some(e => {
      if (BigInt(e.record.kind) !== 0n) return false;

      const existingEnvelope = decodePayload(e.payloadBytes, e.record);
      return existingEnvelope.payload.id === request.id;
    });
    requireThat(!hasDuplicateRequest, 'DUPLICATE_REQUEST');
    const registered = await register(envelope, bytes => logClient.registerRequest(bytes));
    try {
      const verificationContext = await getVerificationContext(registered.entry.checkpointId);
      return buildBundle(entries, registered.entry, undefined, verificationContext);
    } catch (error) {
      throw withRegistration(error, registered.registration);
    }
  }

  async function decide(receipt) {
    requireThat(
      receipt?.request && receipt.checkpointId !== undefined && receipt.checkpointId !== null,
      'MISSING_EVIDENCE'
    );
    const evidence = structuredClone(receipt);
    const verificationContext = await getVerificationContext(evidence.checkpointId);
    const { record, envelope, request: r } = verifyRequestEvidence(evidence, verificationContext);

    const hasDuplicateRequest = entries.some(e => {
      if (BigInt(e.record.kind) !== 0n) return false;

      const existingEnvelope = decodePayload(e.payloadBytes, e.record);
      if (existingEnvelope.payload.id !== r.id) return false;

      return BigInt(e.record.index) !== BigInt(record.index);
    });
    requireThat(!hasDuplicateRequest, 'DUPLICATE_REQUEST');

    const hasDuplicateDecision = entries.some(e => {
      if (BigInt(e.record.kind) !== 1n) return false;
      return BigInt(e.record.requestIndex) === BigInt(record.index);
    });
    requireThat(!hasDuplicateDecision, 'DUPLICATE_DECISION');
    buildBundle(entries, evidence.request.entry, undefined, verificationContext);

    const payload = {
      version: 1,
      requestHash: hash(envelope),
      policyHash: hash(policySnapshot),
      ...evaluateRequest(r)
    };
    const decisionEnvelope = sign('decision', payload, institutionPrivateKey);
    const registered = await register(
      decisionEnvelope,
      bytes => logClient.registerDecision(record.index, bytes)
    );
    try {
      const decisionVerificationContext = await getVerificationContext(registered.entry.checkpointId);
      return buildBundle(entries, evidence.request.entry, registered.entry, decisionVerificationContext);
    } catch (error) {
      throw withRegistration(error, registered.registration);
    }
  }

  async function getVerificationContext(checkpointId) {
    requireThat(checkpointId !== undefined && checkpointId !== null, 'CHECKPOINT_REQUIRED');
    const selectedCheckpoint = await logClient.readCheckpoint(checkpointId);
    return structuredClone({
      ...baseVerificationContext,
      checkpointId: selectedCheckpoint.checkpointId,
      checkpoint: selectedCheckpoint.checkpoint
    });
  }

  async function exportLog(checkpointId) {
    requireThat(checkpointId !== undefined && checkpointId !== null, 'CHECKPOINT_REQUIRED');
    const { checkpoint } = await logClient.readCheckpoint(checkpointId);
    return structuredClone(entries.slice(0, safeNumber(checkpoint.size)));
  }

  return {
    accept,
    decide,
    getVerificationContext,
    exportLog
  };
}
