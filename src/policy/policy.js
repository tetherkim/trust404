import {
  fields,
  check,
  canonical,
  hash,
  integer,
  hashShape,
  addressShape,
  verifySignature,
  sign
} from '../common/crypto.js';

export const scopeFields = ['version', 'logId', 'chainId', 'anchorAddress'];

/**
 * Extracts scope fields from an object.
 *
 * @param {object} value - Object containing scope fields.
 * @returns {object} Filtered object with only scope fields.
 */
export const scope = value => Object.fromEntries(scopeFields.map(key => [key, value[key]]));

/**
 * Validates the common scope fields (version, logId, chainId, anchorAddress).
 *
 * @param {object} value - Scope object to validate.
 */
function validateScope(value) {
  check(
    value.version === 3 &&
    typeof value.logId === 'string' &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.logId),
    'INVALID_SCOPE'
  );
  integer(value.chainId, true);
  check(addressShape(value.anchorAddress), 'INVALID_SCOPE');
}

/**
 * Validates a trust profile configuration against supported lending policies.
 *
 * @param {object} trust - The trust configuration containing policy, keys, and hashes.
 * @returns {object} The validated policy.
 */
export function validateTrust(trust) {
  const policy = trust.policy;
  validateScope(policy);

  if (policy.policyId === 'usdc-reserve-v1') {
    fields(policy, [
      ...scopeFields,
      'policyId',
      'ruleVersion',
      'institutionId',
      'token',
      'decimals',
      'treasury',
      'limitAtomic',
      'reserveAtomic',
      'decisionWindowSeconds',
      'stateRule'
    ]);
    check(
      policy.ruleVersion === 1 &&
      typeof policy.institutionId === 'string' &&
      policy.decimals === 6 &&
      policy.decisionWindowSeconds === 90 &&
      policy.stateRule === 'RECEIPT_BLOCK_END',
      'UNSUPPORTED_POLICY'
    );
    check(
      addressShape(policy.token) &&
      addressShape(policy.treasury) &&
      addressShape(trust.publisher) &&
      hashShape(trust.codeHash),
      'INVALID_TRUST'
    );
    integer(policy.limitAtomic, true);
    integer(policy.reserveAtomic);
  } else if (policy.policyId === 'credit-ltv-v1') {
    fields(policy, [
      ...scopeFields,
      'policyId',
      'ruleVersion',
      'evaluatorVersion',
      'institutionId',
      'creditStateAddress',
      'maxLtvBps',
      'decisionWindowSeconds',
      'stateRule'
    ]);
    check(
      policy.ruleVersion === 1 &&
      policy.evaluatorVersion === 1 &&
      typeof policy.institutionId === 'string' &&
      policy.decisionWindowSeconds === 90 &&
      policy.stateRule === 'RECEIPT_BLOCK_END',
      'UNSUPPORTED_POLICY'
    );
    check(
      addressShape(policy.creditStateAddress) &&
      addressShape(trust.publisher) &&
      hashShape(trust.codeHash),
      'INVALID_TRUST'
    );
    integer(policy.maxLtvBps, true);
  } else {
    throw new Error('UNSUPPORTED_POLICY');
  }

  check(hash('policy-v3', policy) === trust.policyHash, 'POLICY_HASH_MISMATCH');
  check(trust.requesterKeys && trust.institutionKeys, 'INVALID_TRUST');
  return policy;
}

/**
 * Validates an incoming signed request record against the trust profile.
 *
 * @param {object} record - Request record { kind: 'REQUEST', requestId, request: envelope }.
 * @param {object} trust - Validated trust profile.
 * @returns {object} The verified inner request payload.
 */
export function validateRequest(record, trust) {
  fields(record, ['kind', 'requestId', 'request']);
  check(record.kind === 'REQUEST', 'INVALID_RECORD');

  const policy = validateTrust(trust);
  const requestPayload = verifySignature(record.request, 'request-v3', trust.requesterKeys);

  if (policy.policyId === 'usdc-reserve-v1') {
    fields(requestPayload, [
      ...scopeFields,
      'requesterId',
      'institutionId',
      'token',
      'treasury',
      'recipient',
      'amountAtomic',
      'createdAtMs',
      'policyHash'
    ]);
    check(
      canonical(scope(requestPayload)) === canonical(scope(policy)) &&
      requestPayload.institutionId === policy.institutionId &&
      requestPayload.token === policy.token &&
      requestPayload.treasury === policy.treasury &&
      requestPayload.policyHash === trust.policyHash &&
      requestPayload.requesterId === record.request.keyId,
      'REQUEST_CONTEXT_MISMATCH'
    );
    check(addressShape(requestPayload.recipient), 'INVALID_RECIPIENT');
    integer(requestPayload.amountAtomic, true);
    integer(requestPayload.createdAtMs);
  } else if (policy.policyId === 'credit-ltv-v1') {
    fields(requestPayload, [
      ...scopeFields,
      'requesterId',
      'institutionId',
      'subject',
      'creditStateAddress',
      'borrowAmountAtomic',
      'createdAtMs',
      'policyHash'
    ]);
    check(
      canonical(scope(requestPayload)) === canonical(scope(policy)) &&
      requestPayload.institutionId === policy.institutionId &&
      requestPayload.creditStateAddress === policy.creditStateAddress &&
      requestPayload.policyHash === trust.policyHash &&
      requestPayload.requesterId === record.request.keyId,
      'REQUEST_CONTEXT_MISMATCH'
    );
    check(addressShape(requestPayload.subject), 'INVALID_SUBJECT');
    integer(requestPayload.borrowAmountAtomic, true);
    integer(requestPayload.createdAtMs);
  }

  check(hash('request-id-v3', requestPayload) === record.requestId, 'REQUEST_ID_MISMATCH');
  return requestPayload;
}

/**
 * Builds and signs a request record for a given payload.
 *
 * @param {object} payload - The request parameters.
 * @param {string} keyId - Requester key ID.
 * @param {KeyObject|string} key - Requester private key.
 * @returns {object} { kind: 'REQUEST', requestId, request: envelope }
 */
export function requestRecord(payload, keyId, key) {
  return {
    kind: 'REQUEST',
    requestId: hash('request-id-v3', payload),
    request: sign('request-v3', keyId, payload, key)
  };
}

/**
 * Evaluates a loan request against the USDC reserve policy.
 *
 * @param {string|number|bigint} amount - Requested amount (atomic units).
 * @param {string|number|bigint|null} balance - Current treasury balance.
 * @param {object} policy - Policy rules (limitAtomic, reserveAtomic).
 * @returns {{ outcome: 'APPROVED'|'REJECTED', reason: string }}
 */
export function evaluate(amount, balance, policy) {
  const requestedAmount = integer(amount, true);
  const limitAmount = integer(policy.limitAtomic, true);
  const reserveFloor = integer(policy.reserveAtomic);

  if (requestedAmount > limitAmount) {
    return { outcome: 'REJECTED', reason: 'LIMIT_EXCEEDED' };
  }

  check(balance !== null && balance !== undefined, 'STATE_UNAVAILABLE');

  const treasuryBalance = integer(balance);
  const requiredBalance = requestedAmount + reserveFloor;

  if (treasuryBalance < requiredBalance) {
    return { outcome: 'REJECTED', reason: 'RESERVE_FLOOR' };
  }

  return { outcome: 'APPROVED', reason: 'POLICY_SATISFIED' };
}

/**
 * Evaluates deterministic lending eligibility under Credit LTV Policy.
 *
 * @param {object} snapshot - State snapshot containing collateral and debt.
 * @param {object} request - Request containing borrowAmount.
 * @param {object} policy - Policy containing maxLtvBps.
 * @returns {{ outcome: 'APPROVED'|'REJECTED', reason: string, derived: object }}
 */
export function evaluatePolicy(snapshot, request, policy) {
  check(snapshot && typeof snapshot === 'object', 'STATE_UNAVAILABLE');
  check(request && typeof request === 'object', 'INVALID_REQUEST');
  check(policy && typeof policy === 'object', 'INVALID_POLICY');

  const collateral = integer(snapshot.collateral);
  const currentDebt = integer(snapshot.debt);
  const borrowAmount = integer(request.borrowAmountAtomic ?? request.amountAtomic, true);
  const maxLtvBps = integer(policy.maxLtvBps, true);

  if (collateral === 0n) {
    return {
      outcome: 'REJECTED',
      reason: 'NO_COLLATERAL',
      derived: {
        collateral: '0',
        currentDebt: currentDebt.toString(),
        requestedDebt: borrowAmount.toString(),
        postDebt: (currentDebt + borrowAmount).toString(),
        ltvBps: 100000,
        maxLtvBps: Number(maxLtvBps)
      }
    };
  }

  const postDebt = currentDebt + borrowAmount;
  const ltvBps = (postDebt * 10000n) / collateral;

  const derived = {
    collateral: collateral.toString(),
    currentDebt: currentDebt.toString(),
    requestedDebt: borrowAmount.toString(),
    postDebt: postDebt.toString(),
    ltvBps: Number(ltvBps),
    maxLtvBps: Number(maxLtvBps)
  };

  if (ltvBps > maxLtvBps) {
    return {
      outcome: 'REJECTED',
      reason: 'LTV_EXCEEDED',
      derived
    };
  }

  return {
    outcome: 'APPROVED',
    reason: 'POLICY_SATISFIED',
    derived
  };
}

/**
 * Creates and validates a StateSnapshot object.
 *
 * @param {object} params
 * @returns {object} Standardized state snapshot.
 */
export function stateSnapshot(params) {
  const snapshot = {
    chainId: String(integer(params.chainId, true)),
    blockNumber: String(integer(params.blockNumber)),
    blockHash: params.blockHash,
    targetContract: params.targetContract,
    subject: params.subject,
    collateral: String(integer(params.collateral)),
    debt: String(integer(params.debt))
  };

  check(hashShape(snapshot.blockHash), 'INVALID_BLOCK_HASH');
  check(addressShape(snapshot.targetContract), 'INVALID_CONTRACT');
  check(addressShape(snapshot.subject), 'INVALID_SUBJECT');

  return snapshot;
}

/**
 * Builds a receipt reference linking a request to its anchored batch.
 *
 * @param {object} meta - Batch metadata (batchId, blockNumber, blockHash).
 * @param {number} index - Leaf index within batch.
 * @returns {object} Receipt reference.
 */
export function receiptRef(meta, index) {
  return {
    batchId: String(meta.batchId),
    leafIndex: index,
    blockNumber: String(meta.blockNumber),
    blockHash: meta.blockHash
  };
}

/**
 * Evaluates a request, fetches on-chain state at reference block,
 * constructs decision record, and signs it with institution key.
 *
 * @param {object} request - The request record.
 * @param {object} ref - Receipt reference.
 * @param {object} trust - Trust configuration.
 * @param {object} reader - Chain reader or mock reader.
 * @param {string} keyId - Institution signing key ID.
 * @param {KeyObject|string} privateKey - Institution private key.
 * @returns {Promise<{ record: object, snapshot: object|null }>}
 */
export async function makeDecision(request, ref, trust, reader, keyId, privateKey) {
  const validatedRequest = validateRequest(request, trust);
  const policy = trust.policy;
  check(Object.hasOwn(trust.institutionKeys, keyId), 'UNKNOWN_SIGNER');

  if (policy.policyId === 'usdc-reserve-v1') {
    let snapshot = null;
    const requestedAmount = integer(validatedRequest.amountAtomic);
    const limitAmount = integer(policy.limitAtomic);

    if (requestedAmount <= limitAmount) {
      const balance = await reader.balance(ref, policy);
      snapshot = {
        ...scope(policy),
        requestId: request.requestId,
        receiptRef: ref,
        token: policy.token,
        treasury: policy.treasury,
        method: 'balanceOf',
        args: [policy.treasury],
        balanceAtomic: balance
      };
    }

    const evaluation = evaluate(validatedRequest.amountAtomic, snapshot?.balanceAtomic, policy);
    const payload = {
      ...scope(policy),
      requestId: request.requestId,
      policyHash: trust.policyHash,
      receiptRef: ref,
      stateHash: snapshot ? hash('state-v3', snapshot) : null,
      ...evaluation
    };

    const decision = sign('decision-v3', keyId, payload, privateKey);
    verifySignature(decision, 'decision-v3', trust.institutionKeys);

    return {
      record: { kind: 'DECISION', decision },
      snapshot
    };
  }

  if (policy.policyId === 'credit-ltv-v1') {
    const rawState = await reader.creditState(ref, validatedRequest.subject, policy.creditStateAddress);
    const snapshot = stateSnapshot({
      chainId: policy.chainId,
      blockNumber: ref.blockNumber,
      blockHash: ref.blockHash,
      targetContract: policy.creditStateAddress,
      subject: validatedRequest.subject,
      collateral: rawState.collateral,
      debt: rawState.debt
    });

    const evaluation = evaluatePolicy(snapshot, validatedRequest, policy);
    const payload = {
      ...scope(policy),
      requestId: request.requestId,
      policyHash: trust.policyHash,
      receiptRef: ref,
      stateHash: hash('state-v3', snapshot),
      outcome: evaluation.outcome,
      reason: evaluation.reason,
      derived: evaluation.derived
    };

    const decision = sign('decision-v3', keyId, payload, privateKey);
    verifySignature(decision, 'decision-v3', trust.institutionKeys);

    return {
      record: { kind: 'DECISION', decision },
      snapshot
    };
  }

  throw new Error('UNSUPPORTED_POLICY');
}

/**
 * Validates a decision record against its corresponding request and historical state.
 *
 * @param {object} record - Decision record.
 * @param {object} request - Associated request record.
 * @param {object} ref - Associated receipt reference.
 * @param {object|null} snapshot - State snapshot corresponding to decision stateHash.
 * @param {object} trust - Trust configuration.
 * @param {object} reader - Chain reader for state replay/re-fetch.
 * @returns {Promise<object>} Verified decision payload.
 */
export async function validateDecision(record, request, ref, snapshot, trust, reader) {
  fields(record, ['kind', 'decision']);
  check(record.kind === 'DECISION', 'INVALID_RECORD');

  const decisionPayload = verifySignature(record.decision, 'decision-v3', trust.institutionKeys);
  const policy = trust.policy;

  if (policy.policyId === 'usdc-reserve-v1') {
    fields(decisionPayload, [
      ...scopeFields,
      'requestId',
      'policyHash',
      'receiptRef',
      'stateHash',
      'outcome',
      'reason'
    ]);
    check(
      canonical(scope(decisionPayload)) === canonical(scope(policy)) &&
      decisionPayload.requestId === request.requestId &&
      decisionPayload.policyHash === trust.policyHash,
      'DECISION_CONTEXT_MISMATCH'
    );
    check(canonical(decisionPayload.receiptRef) === canonical(ref), 'RECEIPT_MISMATCH');

    const amount = request.request.payload.amountAtomic;
    let balance = null;

    if (integer(amount) <= integer(policy.limitAtomic)) {
      check(snapshot, 'DATA_UNAVAILABLE');
      check(hash('state-v3', snapshot) === decisionPayload.stateHash, 'STATE_HASH_MISMATCH');

      balance = await reader.balance(ref, policy);
      const expectedSnapshot = {
        ...scope(policy),
        requestId: request.requestId,
        receiptRef: ref,
        token: policy.token,
        treasury: policy.treasury,
        method: 'balanceOf',
        args: [policy.treasury],
        balanceAtomic: balance
      };
      check(canonical(snapshot) === canonical(expectedSnapshot), 'STATE_MISMATCH');
    } else {
      check(decisionPayload.stateHash === null && snapshot === null, 'UNEXPECTED_STATE');
    }

    const expectedEvaluation = evaluate(amount, balance, policy);
    check(
      decisionPayload.outcome === expectedEvaluation.outcome &&
      decisionPayload.reason === expectedEvaluation.reason,
      'POLICY_MISMATCH'
    );

    return decisionPayload;
  }

  if (policy.policyId === 'credit-ltv-v1') {
    fields(decisionPayload, [
      ...scopeFields,
      'requestId',
      'policyHash',
      'receiptRef',
      'stateHash',
      'outcome',
      'reason',
      'derived'
    ]);
    check(
      canonical(scope(decisionPayload)) === canonical(scope(policy)) &&
      decisionPayload.requestId === request.requestId &&
      decisionPayload.policyHash === trust.policyHash,
      'DECISION_CONTEXT_MISMATCH'
    );
    check(canonical(decisionPayload.receiptRef) === canonical(ref), 'RECEIPT_MISMATCH');
    check(snapshot, 'DATA_UNAVAILABLE');
    check(hash('state-v3', snapshot) === decisionPayload.stateHash, 'STATE_HASH_MISMATCH');

    if (reader && typeof reader.creditState === 'function') {
      const rawState = await reader.creditState(ref, request.request.payload.subject, policy.creditStateAddress);
      const expectedSnapshot = stateSnapshot({
        chainId: policy.chainId,
        blockNumber: ref.blockNumber,
        blockHash: ref.blockHash,
        targetContract: policy.creditStateAddress,
        subject: request.request.payload.subject,
        collateral: rawState.collateral,
        debt: rawState.debt
      });
      check(canonical(snapshot) === canonical(expectedSnapshot), 'STATE_MISMATCH');
    }

    const expectedEvaluation = evaluatePolicy(snapshot, request.request.payload, policy);
    check(
      decisionPayload.outcome === expectedEvaluation.outcome &&
      decisionPayload.reason === expectedEvaluation.reason,
      'POLICY_MISMATCH'
    );
    check(canonical(decisionPayload.derived) === canonical(expectedEvaluation.derived), 'DERIVED_MISMATCH');

    return decisionPayload;
  }

  throw new Error('UNSUPPORTED_POLICY');
}
