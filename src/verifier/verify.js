import { check, canonical, verifySignature } from '../common/crypto.js';
import { buildTree, verifyProof } from '../common/merkle.js';
import {
  validateTrust,
  validateRequest,
  validateDecision,
  receiptRef,
  evaluatePolicy
} from '../policy/policy.js';

const OPERATIONAL_ERRORS = new Set([
  'RPC_UNAVAILABLE',
  'BLOCK_UNAVAILABLE',
  'FINALITY_UNAVAILABLE',
  'STATE_UNAVAILABLE',
  'DATA_UNAVAILABLE',
  'REORG',
  'BATCH_UNAVAILABLE'
]);

/**
 * Determines SLA registration timing status.
 *
 * @param {object} requestMeta - Batch metadata of request.
 * @param {object|null} decisionMeta - Batch metadata of decision (if recorded).
 * @param {object} context - Chain view context (timestamp).
 * @returns {'REGISTERED_ON_TIME'|'REGISTERED_LATE'|'PENDING'|'MISSING_AS_OF_H'}
 */
export function timing(requestMeta, decisionMeta, context) {
  const deadline = BigInt(requestMeta.anchoredAt) + 90n;
  if (decisionMeta) {
    return BigInt(decisionMeta.anchoredAt) <= deadline
      ? 'REGISTERED_ON_TIME'
      : 'REGISTERED_LATE';
  }
  return BigInt(context.timestamp) <= deadline
    ? 'PENDING'
    : 'MISSING_AS_OF_H';
}

/**
 * Verifies inclusion of a record inside an on-chain batch Merkle root.
 *
 * @param {object} item - Item bundle { batchId, count, index, proof, record }
 * @param {import('../chain/reader.js').ChainView} chain - Pinned chain view
 * @returns {Promise<object>} Batch metadata
 */
async function verifyInclusion(item, chain) {
  check(item && item.record, 'DATA_UNAVAILABLE');
  const batchMeta = await chain.batch(item.batchId);
  check(item.count === batchMeta.count, 'INVALID_INCLUSION');
  verifyProof(item.record, item.index, item.count, item.proof, batchMeta.root);
  return batchMeta;
}

/**
 * Validates request-decision causal ordering and verifies decision correctness.
 */
async function checkPair(request, decision, ref, requestMeta, decisionMeta, snapshot, trust, chain) {
  check(BigInt(decisionMeta.blockNumber) > BigInt(requestMeta.blockNumber), 'INVALID_EVENT_ORDER');
  return validateDecision(decision, request, ref, snapshot, trust, chain);
}

/**
 * Independently verifies a single evidence bundle without trusting the institution's DB.
 *
 * @param {object} bundle - Exported evidence bundle { request, decision, snapshot }.
 * @param {object} trust - Published trust configuration.
 * @param {import('../chain/reader.js').ChainView} chain - Pinned chain view.
 * @param {object} [runtime=null] - Optional runtime adapter for execution harness.
 * @returns {Promise<object>} Verification report.
 */
export async function verifyOne(bundle, trust, chain, runtime = null) {
  validateTrust(trust);
  await chain.assertCanonical();

  const requestBatchMeta = await verifyInclusion(bundle.request, chain);
  const decisionBatchMeta = await verifyInclusion(bundle.decision, chain);

  const requestRecord = bundle.request.record;
  validateRequest(requestRecord, trust);

  const ref = receiptRef(requestBatchMeta, bundle.request.index);
  const verifiedDecision = await checkPair(
    requestRecord,
    bundle.decision.record,
    ref,
    requestBatchMeta,
    decisionBatchMeta,
    bundle.snapshot ?? null,
    trust,
    chain
  );

  await chain.assertCanonical();

  const recordIntegrity = {
    requestSignature: 'VALID',
    decisionSignature: 'VALID',
    requestProof: 'VALID',
    decisionProof: 'VALID',
    onchainRoots: 'MATCH'
  };

  let replay = null;
  if (trust.policy.policyId === 'credit-ltv-v1') {
    const decisionPayload = verifiedDecision;
    const blockNumber = decisionPayload.blockNumber ?? ref.blockNumber;
    let replayedState;

    if (runtime && typeof runtime.replayStateAtBlock === 'function') {
      replayedState = await runtime.replayStateAtBlock({
        blockNumber,
        blockHash: ref.blockHash,
        targetContract: trust.policy.creditStateAddress,
        subject: requestRecord.request.payload.subject
      });
    } else {
      replayedState = await chain.creditState(ref, requestRecord.request.payload.subject, trust.policy.creditStateAddress);
      replayedState.blockNumber = String(blockNumber);
      replayedState.blockHash = ref.blockHash;
    }

    check(
      replayedState.blockHash === ref.blockHash &&
      String(replayedState.blockNumber) === String(ref.blockNumber),
      'REORG'
    );

    const isStateIdentical =
      replayedState.collateral === bundle.snapshot.collateral &&
      replayedState.debt === bundle.snapshot.debt;
    check(isStateIdentical, 'STATE_MISMATCH');

    const replayedEvaluation = evaluatePolicy(bundle.snapshot, requestRecord.request.payload, trust.policy);
    const isPolicyIdentical =
      replayedEvaluation.outcome === decisionPayload.outcome &&
      replayedEvaluation.reason === decisionPayload.reason;
    check(isPolicyIdentical, 'POLICY_MISMATCH');

    replay = {
      blockNumber: String(blockNumber),
      blockHash: replayedState.blockHash ?? ref.blockHash,
      state: 'MATCH',
      policy: 'MATCH',
      outcome: 'MATCH'
    };
  }

  return {
    ok: true,
    status: 'VERIFIED',
    requestId: requestRecord.requestId,
    record: 'VALID',
    policy: 'MATCH',
    outcome: verifiedDecision.outcome,
    reason: verifiedDecision.reason,
    decision: {
      outcome: verifiedDecision.outcome,
      reason: verifiedDecision.reason
    },
    timing: timing(requestBatchMeta, decisionBatchMeta, chain.context),
    finality: chain.finality,
    asOf: chain.context,
    recordIntegrity,
    replay
  };
}

/**
 * Performs a comprehensive audit of all on-chain anchored batches against an archive.
 * Detects tampering, omission, deletion, duplicate decisions, and late registrations.
 *
 * @param {import('../storage/store.js').Archive} archive - Public archive of batches and state blobs.
 * @param {object} trust - Published trust configuration.
 * @param {import('../chain/reader.js').ChainView} chain - Pinned chain view.
 * @returns {Promise<object>} Complete audit report.
 */
export async function auditAll(archive, trust, chain) {
  validateTrust(trust);
  await chain.assertCanonical();

  const totalBatches = BigInt(await chain.count());
  const requests = new Map();
  const decisions = new Map();
  const issues = [];
  let isComplete = true;

  for (let id = 1n; id <= totalBatches; id++) {
    const batchIdStr = id.toString();
    const batchMeta = await chain.batch(batchIdStr);
    let records;

    try {
      records = await archive.batch(batchIdStr);
    } catch {
      isComplete = false;
      issues.push({ batchId: batchIdStr, code: 'DATA_UNAVAILABLE' });
      continue;
    }

    let isValidRoot = false;
    try {
      isValidRoot =
        Array.isArray(records) &&
        records.length === batchMeta.count &&
        buildTree(records).root === batchMeta.root;
    } catch {
      isValidRoot = false;
    }

    if (!isValidRoot) {
      isComplete = false;
      issues.push({ batchId: batchIdStr, code: 'TAMPERED_EXPORT' });
      continue;
    }

    for (const [index, record] of records.entries()) {
      try {
        if (record.kind === 'REQUEST') {
          validateRequest(record, trust);
          if (requests.has(record.requestId)) {
            issues.push({ requestId: record.requestId, code: 'DUPLICATE_REQUEST' });
          } else {
            requests.set(record.requestId, {
              record,
              meta: batchMeta,
              ref: receiptRef(batchMeta, index)
            });
          }
        } else if (record.kind === 'DECISION') {
          const requestId = record.decision?.payload?.requestId;
          check(typeof requestId === 'string', 'INVALID_RECORD');
          const decisionList = decisions.get(requestId) ?? [];
          decisionList.push({ record, meta: batchMeta });
          decisions.set(requestId, decisionList);
        } else {
          throw new Error('INVALID_RECORD');
        }
      } catch (err) {
        isComplete = false;
        issues.push({ batchId: batchIdStr, index, code: err.message });
      }
    }
  }

  const results = [];
  for (const [requestId, requestInfo] of requests) {
    const decisionList = decisions.get(requestId) ?? [];
    const requestResult = {
      requestId,
      timing: (!isComplete && !decisionList.length)
        ? 'UNKNOWN'
        : timing(requestInfo.meta, decisionList[0]?.meta, chain.context),
      decisions: []
    };

    const uniquePayloads = new Set();
    for (const { record, meta } of decisionList) {
      try {
        const signedPayload = verifySignature(record.decision, 'decision-v3', trust.institutionKeys);
        uniquePayloads.add(canonical(signedPayload));

        const stateHash = signedPayload.stateHash;
        let snapshot = null;
        if (stateHash !== null) {
          try {
            snapshot = await archive.blob(stateHash);
          } catch {
            throw new Error('DATA_UNAVAILABLE');
          }
        }

        const verifiedDecision = await checkPair(
          requestInfo.record,
          record,
          requestInfo.ref,
          requestInfo.meta,
          meta,
          snapshot,
          trust,
          chain
        );

        uniquePayloads.add(canonical(verifiedDecision));
        requestResult.decisions.push({
          record: 'VALID',
          policy: 'MATCH',
          outcome: verifiedDecision.outcome,
          reason: verifiedDecision.reason,
          timing: timing(requestInfo.meta, meta, chain.context)
        });
      } catch (err) {
        if (OPERATIONAL_ERRORS.has(err.message)) {
          isComplete = false;
        }
        requestResult.decisions.push({ error: err.message });
        issues.push({ requestId, code: err.message });
      }
    }

    if (decisionList.length > 1) {
      issues.push({
        requestId,
        code: uniquePayloads.size > 1 ? 'CONFLICTING_DECISIONS' : 'DUPLICATE_DECISION'
      });
    }

    results.push(requestResult);
  }

  for (const requestId of decisions.keys()) {
    if (!requests.has(requestId)) {
      issues.push({ requestId, code: 'UNMATCHED_DECISION' });
    }
  }

  if (!isComplete) {
    for (const res of results) {
      if (!res.decisions.length) {
        res.timing = 'UNKNOWN';
      }
    }
  }

  await chain.assertCanonical();

  const isAllValid =
    isComplete &&
    !issues.length &&
    results.every(r => !['MISSING_AS_OF_H', 'REGISTERED_LATE'].includes(r.timing));

  return {
    ok: isAllValid,
    complete: isComplete,
    batchCount: totalBatches.toString(),
    asOf: chain.context,
    finality: chain.finality,
    requests: results,
    issues
  };
}
