import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createInstitution, createRequest, decodePayload, encodePayload, hash } from '../src/evidence.js';
import { buildTree, payloadHash } from '../src/evm.js';

export const INSTITUTION = '0x0000000000000000000000000000000000000002';
export const OTHER = '0x0000000000000000000000000000000000000004';
export const POLICY = Object.freeze({
  version: 1,
  id: 'per-transfer-limit-v1',
  institution: 'demo-bank',
  currency: 'KRW',
  limit: 1000000,
  decisionWindow: 60
});
export const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
export const disk = value => JSON.parse(json(value));

// A boundary double for business tests; actual EVM roots/state are checked by the Anvil suite.
export function createTestWitness() {
  const context = { chainId: 31337n, evidenceLogAddress: '0x0000000000000000000000000000000000000003',
    depth: 6, deploymentBlock: 0, institutionAddress: INSTITUTION };
  const records = []; const registrations = new Map(); const checkpoints = new Map(); const calls = [];
  let sequence = 0;
  const logClient = { context, records, calls, time: 1000,
    publish(entry = null) {
      const checkpointId = BigInt(sequence++);
      const result = { txHash: `0x${hash(`tx-${sequence}`)}`, entry, checkpointId,
        checkpoint: { size: BigInt(records.length), root: buildTree(records, context).root, issuedAt: BigInt(logClient.time) },
        blockNumber: sequence, blockHash: `0x${hash(`block-${sequence}`)}` };
      registrations.set(result.txHash, structuredClone(result));
      checkpoints.set(checkpointId, structuredClone(result.checkpoint));
      return structuredClone(result);
    },
    record(bytes, { actor = INSTITUTION, requestIndex } = {}) {
      const index = BigInt(records.length); const kind = requestIndex === undefined ? 0n : 1n;
      assert(index < 2n ** BigInt(context.depth), 'TREE_CAPACITY_EXCEEDED');
      assert(!records.length || BigInt(logClient.time) >= records.at(-1).recordedAt, 'INVALID_TIME');
      if (kind === 0n) {
        assert(!records.some(entry => entry.kind === 0n && entry.actor === actor && entry.payloadHash === payloadHash(bytes)), 'DUPLICATE_REQUEST_HASH');
      } else {
        assert(actor === INSTITUTION && records[Number(requestIndex)]?.kind === 0n, 'INVALID_DECISION_LINK');
        assert(!records.some(entry => entry.kind === 1n && entry.requestIndex === BigInt(requestIndex)), 'DUPLICATE_DECISION');
      }
      const entry = { index, kind, actor, requestIndex: kind === 0n ? index : BigInt(requestIndex),
        payloadHash: payloadHash(bytes), recordedAt: BigInt(logClient.time) };
      records.push(entry);
      return logClient.publish(entry);
    },
    async registerRequest(bytes) {
      calls.push({ method: 'registerRequest', bytes });
      return logClient.record(bytes);
    },
    async registerDecision(requestIndex, bytes) {
      calls.push({ method: 'registerDecision', bytes, requestIndex });
      return logClient.record(bytes, { actor: INSTITUTION, requestIndex });
    },
    async readRecord(txHash) {
      assert(registrations.has(txHash), 'REGISTRATION_NOT_CONFIRMED');
      return structuredClone(registrations.get(txHash));
    },
    async readCheckpoint(checkpointId) {
      checkpointId = BigInt(checkpointId);
      assert(checkpoints.has(checkpointId), 'CHECKPOINT_NOT_FOUND');
      return { checkpointId, checkpoint: structuredClone(checkpoints.get(checkpointId)) };
    },
    async readLatestCheckpoint() {
      assert(sequence > 0, 'CHECKPOINT_NOT_FOUND');
      return logClient.readCheckpoint(BigInt(sequence - 1));
    },
    async createCheckpoint() { return logClient.publish(); },
  };
  return logClient;
}

export function entryView(registration, bytes) {
  return { payloadBytes: bytes, record: registration.entry, checkpointId: registration.checkpointId };
}

export function alterPayload(entry, change) {
  const envelope = decodePayload(entry.payloadBytes, entry.record);
  change(envelope);
  entry.payloadBytes = encodePayload(envelope);
}

export async function fixture(amount = 1500000) {
  const logClient = createTestWitness();
  const customerKeys = generateKeyPairSync('ed25519');
  const institutionKeys = generateKeyPairSync('ed25519');
  const customerKey = customerKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const institution = createInstitution({
    logClient,
    policy: POLICY,
    institutionKeys,
    customerKey
  });
  const envelope = createRequest({
    id: 'req-1', amount, policy: POLICY, customerPrivateKey: customerKeys.privateKey
  });
  const receipt = await institution.accept(envelope);
  const request = receipt.request.entry;
  logClient.time = 1060;
  const bundle = await institution.decide(receipt);
  const decision = bundle.decision.entry;
  const verificationContext = await institution.getVerificationContext(bundle.checkpointId);
  const entries = await institution.exportLog(bundle.checkpointId);
  return {
    logClient, institution, customerKeys, institutionKeys, customerKey,
    request, receipt, decision, verificationContext, bundle, entries, policy: POLICY
  };
}
