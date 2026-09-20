import { fields, check, canonical, hash, integer, hashShape, addressShape, verifySignature, sign } from './crypto.js';

const scopeFields = ['version', 'logId', 'chainId', 'anchorAddress'];
export const scope = value => Object.fromEntries(scopeFields.map(k => [k, value[k]]));

function validateScope(value) {
  check(value.version === 3 && typeof value.logId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.logId), 'INVALID_SCOPE');
  integer(value.chainId, true);
  check(addressShape(value.anchorAddress), 'INVALID_SCOPE');
}

export function validateTrust(trust) {
  const p = trust.policy;
  validateScope(p);
  if (p.policyId === 'usdc-reserve-v1') {
    fields(p, [...scopeFields, 'policyId', 'ruleVersion', 'institutionId', 'token', 'decimals', 'treasury',
      'limitAtomic', 'reserveAtomic', 'decisionWindowSeconds', 'stateRule']);
    check(p.ruleVersion === 1 && typeof p.institutionId === 'string' &&
      p.decimals === 6 && p.decisionWindowSeconds === 90 && p.stateRule === 'RECEIPT_BLOCK_END', 'UNSUPPORTED_POLICY');
    check(addressShape(p.token) && addressShape(p.treasury) && addressShape(trust.publisher) && hashShape(trust.codeHash), 'INVALID_TRUST');
    integer(p.limitAtomic, true); integer(p.reserveAtomic);
  } else if (p.policyId === 'credit-ltv-v1') {
    fields(p, [...scopeFields, 'policyId', 'ruleVersion', 'evaluatorVersion', 'institutionId', 'creditStateAddress',
      'maxLtvBps', 'decisionWindowSeconds', 'stateRule']);
    check(p.ruleVersion === 1 && p.evaluatorVersion === 1 && typeof p.institutionId === 'string' &&
      p.decisionWindowSeconds === 90 && p.stateRule === 'RECEIPT_BLOCK_END', 'UNSUPPORTED_POLICY');
    check(addressShape(p.creditStateAddress) && addressShape(trust.publisher) && hashShape(trust.codeHash), 'INVALID_TRUST');
    integer(p.maxLtvBps, true);
  } else {
    throw new Error('UNSUPPORTED_POLICY');
  }
  check(hash('policy-v3', p) === trust.policyHash, 'POLICY_HASH_MISMATCH');
  check(trust.requesterKeys && trust.institutionKeys, 'INVALID_TRUST');
  return p;
}

export function validateRequest(record, trust) {
  fields(record, ['kind', 'requestId', 'request']);
  check(record.kind === 'REQUEST', 'INVALID_RECORD');
  const p = validateTrust(trust), r = verifySignature(record.request, 'request-v3', trust.requesterKeys);
  if (p.policyId === 'usdc-reserve-v1') {
    fields(r, [...scopeFields, 'requesterId', 'institutionId', 'token', 'treasury', 'recipient', 'amountAtomic', 'createdAtMs', 'policyHash']);
    check(canonical(scope(r)) === canonical(scope(p)) && r.institutionId === p.institutionId && r.token === p.token &&
      r.treasury === p.treasury && r.policyHash === trust.policyHash && r.requesterId === record.request.keyId,
      'REQUEST_CONTEXT_MISMATCH');
    check(addressShape(r.recipient), 'INVALID_RECIPIENT');
    integer(r.amountAtomic, true); integer(r.createdAtMs);
  } else if (p.policyId === 'credit-ltv-v1') {
    fields(r, [...scopeFields, 'requesterId', 'institutionId', 'subject', 'creditStateAddress', 'borrowAmountAtomic', 'createdAtMs', 'policyHash']);
    check(canonical(scope(r)) === canonical(scope(p)) && r.institutionId === p.institutionId &&
      r.creditStateAddress === p.creditStateAddress && r.policyHash === trust.policyHash && r.requesterId === record.request.keyId,
      'REQUEST_CONTEXT_MISMATCH');
    check(addressShape(r.subject), 'INVALID_SUBJECT');
    integer(r.borrowAmountAtomic, true); integer(r.createdAtMs);
  }
  check(hash('request-id-v3', r) === record.requestId, 'REQUEST_ID_MISMATCH');
  return r;
}

export function requestRecord(payload, keyId, key) {
  return { kind: 'REQUEST', requestId: hash('request-id-v3', payload), request: sign('request-v3', keyId, payload, key) };
}

export function evaluate(amount, balance, policy) {
  const a = integer(amount, true), limit = integer(policy.limitAtomic, true), reserve = integer(policy.reserveAtomic);
  if (a > limit) return { outcome: 'REJECTED', reason: 'LIMIT_EXCEEDED' };
  check(balance !== null && balance !== undefined, 'STATE_UNAVAILABLE');
  return integer(balance) < a + reserve
    ? { outcome: 'REJECTED', reason: 'RESERVE_FLOOR' }
    : { outcome: 'APPROVED', reason: 'POLICY_SATISFIED' };
}

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

export function stateSnapshot(params) {
  const s = {
    chainId: String(integer(params.chainId, true)),
    blockNumber: String(integer(params.blockNumber)),
    blockHash: params.blockHash,
    targetContract: params.targetContract,
    subject: params.subject,
    collateral: String(integer(params.collateral)),
    debt: String(integer(params.debt))
  };
  check(hashShape(s.blockHash), 'INVALID_BLOCK_HASH');
  check(addressShape(s.targetContract), 'INVALID_CONTRACT');
  check(addressShape(s.subject), 'INVALID_SUBJECT');
  return s;
}

export function receiptRef(meta, index) {
  return { batchId: String(meta.batchId), leafIndex: index, blockNumber: String(meta.blockNumber), blockHash: meta.blockHash };
}

export async function makeDecision(request, ref, trust, reader, keyId, privateKey) {
  const r = validateRequest(request, trust), p = trust.policy;
  check(Object.hasOwn(trust.institutionKeys, keyId), 'UNKNOWN_SIGNER');

  if (p.policyId === 'usdc-reserve-v1') {
    let snapshot = null;
    if (integer(r.amountAtomic) <= integer(p.limitAtomic)) {
      snapshot = { ...scope(p), requestId: request.requestId, receiptRef: ref, token: p.token, treasury: p.treasury,
        method: 'balanceOf', args: [p.treasury], balanceAtomic: await reader.balance(ref, p) };
    }
    const payload = { ...scope(p), requestId: request.requestId, policyHash: trust.policyHash, receiptRef: ref,
      stateHash: snapshot ? hash('state-v3', snapshot) : null, ...evaluate(r.amountAtomic, snapshot?.balanceAtomic, p) };
    const decision = sign('decision-v3', keyId, payload, privateKey);
    verifySignature(decision, 'decision-v3', trust.institutionKeys);
    return { record: { kind: 'DECISION', decision }, snapshot };
  }

  if (p.policyId === 'credit-ltv-v1') {
    const rawState = await reader.creditState(ref, r.subject, p.creditStateAddress);
    const snapshot = stateSnapshot({
      chainId: p.chainId,
      blockNumber: ref.blockNumber,
      blockHash: ref.blockHash,
      targetContract: p.creditStateAddress,
      subject: r.subject,
      collateral: rawState.collateral,
      debt: rawState.debt
    });
    const evaluation = evaluatePolicy(snapshot, r, p);
    const payload = {
      ...scope(p),
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
    return { record: { kind: 'DECISION', decision }, snapshot };
  }

  throw new Error('UNSUPPORTED_POLICY');
}

export async function validateDecision(record, request, ref, snapshot, trust, reader) {
  fields(record, ['kind', 'decision']); check(record.kind === 'DECISION', 'INVALID_RECORD');
  const d = verifySignature(record.decision, 'decision-v3', trust.institutionKeys), p = trust.policy;

  if (p.policyId === 'usdc-reserve-v1') {
    fields(d, [...scopeFields, 'requestId', 'policyHash', 'receiptRef', 'stateHash', 'outcome', 'reason']);
    check(canonical(scope(d)) === canonical(scope(p)) && d.requestId === request.requestId && d.policyHash === trust.policyHash,
      'DECISION_CONTEXT_MISMATCH');
    check(canonical(d.receiptRef) === canonical(ref), 'RECEIPT_MISMATCH');
    const amount = request.request.payload.amountAtomic;
    let balance = null;
    if (integer(amount) <= integer(p.limitAtomic)) {
      check(snapshot, 'DATA_UNAVAILABLE');
      check(hash('state-v3', snapshot) === d.stateHash, 'STATE_HASH_MISMATCH');
      balance = await reader.balance(ref, p);
      const expected = { ...scope(p), requestId: request.requestId, receiptRef: ref, token: p.token, treasury: p.treasury,
        method: 'balanceOf', args: [p.treasury], balanceAtomic: balance };
      check(canonical(snapshot) === canonical(expected), 'STATE_MISMATCH');
    } else check(d.stateHash === null && snapshot === null, 'UNEXPECTED_STATE');
    const expected = evaluate(amount, balance, p);
    check(d.outcome === expected.outcome && d.reason === expected.reason, 'POLICY_MISMATCH');
    return d;
  }

  if (p.policyId === 'credit-ltv-v1') {
    fields(d, [...scopeFields, 'requestId', 'policyHash', 'receiptRef', 'stateHash', 'outcome', 'reason', 'derived']);
    check(canonical(scope(d)) === canonical(scope(p)) && d.requestId === request.requestId && d.policyHash === trust.policyHash,
      'DECISION_CONTEXT_MISMATCH');
    check(canonical(d.receiptRef) === canonical(ref), 'RECEIPT_MISMATCH');
    check(snapshot, 'DATA_UNAVAILABLE');
    check(hash('state-v3', snapshot) === d.stateHash, 'STATE_HASH_MISMATCH');

    if (reader && typeof reader.creditState === 'function') {
      const rawState = await reader.creditState(ref, request.request.payload.subject, p.creditStateAddress);
      const expectedSnapshot = stateSnapshot({
        chainId: p.chainId,
        blockNumber: ref.blockNumber,
        blockHash: ref.blockHash,
        targetContract: p.creditStateAddress,
        subject: request.request.payload.subject,
        collateral: rawState.collateral,
        debt: rawState.debt
      });
      check(canonical(snapshot) === canonical(expectedSnapshot), 'STATE_MISMATCH');
    }

    const expected = evaluatePolicy(snapshot, request.request.payload, p);
    check(d.outcome === expected.outcome && d.reason === expected.reason, 'POLICY_MISMATCH');
    check(canonical(d.derived) === canonical(expected.derived), 'DERIVED_MISMATCH');
    return d;
  }

  throw new Error('UNSUPPORTED_POLICY');
}
