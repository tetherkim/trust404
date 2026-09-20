import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { hash, canonical } from '../../src/common/crypto.js';
import {
  scope,
  validateTrust,
  validateRequest,
  requestRecord,
  receiptRef,
  evaluatePolicy,
  stateSnapshot,
  makeDecision,
  validateDecision
} from '../../src/policy/policy.js';

function creditFixture() {
  const requester = generateKeyPairSync('ed25519');
  const institution = generateKeyPairSync('ed25519');
  const pub = key => key.export({ type: 'spki', format: 'pem' });

  const anchorAddress = '0x' + '11'.repeat(20);
  const creditStateAddress = '0x' + '22'.repeat(20);
  const alice = '0x' + 'aa'.repeat(20);

  const policy = {
    version: 3,
    logId: 'credit-log-1',
    chainId: '31337',
    anchorAddress,
    policyId: 'credit-ltv-v1',
    ruleVersion: 1,
    evaluatorVersion: 1,
    institutionId: 'trust-lending',
    creditStateAddress,
    maxLtvBps: '7000', // 70.00%
    decisionWindowSeconds: 90,
    stateRule: 'RECEIPT_BLOCK_END'
  };

  const trust = {
    policy,
    policyHash: hash('policy-v3', policy),
    publisher: anchorAddress,
    codeHash: '0x' + '33'.repeat(32),
    requesterKeys: { alice: pub(requester.publicKey) },
    institutionKeys: { 'trust-lending': pub(institution.publicKey) }
  };

  const createRequest = (borrowAmount = '80', createdAt = '1000') =>
    requestRecord(
      {
        ...scope(policy),
        requesterId: 'alice',
        institutionId: policy.institutionId,
        subject: alice,
        creditStateAddress,
        borrowAmountAtomic: borrowAmount,
        createdAtMs: createdAt,
        policyHash: trust.policyHash
      },
      'alice',
      requester.privateKey
    );

  return { trust, requester, institution, alice, createRequest, creditStateAddress };
}

test('[TASK-02] LTV 신용 정책 평가: 결정론적 대출 자격 적격/부적격 평가 검증', () => {
  const policy = { maxLtvBps: '7000' };

  // 1. Collateral 100, Debt 0, Borrow 80 => LTV 80% > 70% -> REJECTED (LTV_EXCEEDED)
  const res1 = evaluatePolicy({ collateral: '100', debt: '0' }, { borrowAmountAtomic: '80' }, policy);
  assert.equal(res1.outcome, 'REJECTED');
  assert.equal(res1.reason, 'LTV_EXCEEDED');
  assert.equal(res1.derived.postDebt, '80');
  assert.equal(res1.derived.ltvBps, 8000);

  // 2. Collateral 100, Debt 0, Borrow 50 => LTV 50% <= 70% -> APPROVED (POLICY_SATISFIED)
  const res2 = evaluatePolicy({ collateral: '100', debt: '0' }, { borrowAmountAtomic: '50' }, policy);
  assert.equal(res2.outcome, 'APPROVED');
  assert.equal(res2.reason, 'POLICY_SATISFIED');
  assert.equal(res2.derived.postDebt, '50');
  assert.equal(res2.derived.ltvBps, 5000);

  // 3. Exact boundary: Collateral 100, Borrow 70 => LTV 70% <= 70% -> APPROVED
  const res3 = evaluatePolicy({ collateral: '100', debt: '0' }, { borrowAmountAtomic: '70' }, policy);
  assert.equal(res3.outcome, 'APPROVED');
  assert.equal(res3.reason, 'POLICY_SATISFIED');

  // 4. Boundary exceed: Collateral 10000, Borrow 7001 => 70.01% > 70% -> REJECTED
  const res4 = evaluatePolicy({ collateral: '10000', debt: '0' }, { borrowAmountAtomic: '7001' }, policy);
  assert.equal(res4.outcome, 'REJECTED');
  assert.equal(res4.reason, 'LTV_EXCEEDED');

  // 5. Zero collateral => REJECTED (NO_COLLATERAL)
  const res5 = evaluatePolicy({ collateral: '0', debt: '0' }, { borrowAmountAtomic: '10' }, policy);
  assert.equal(res5.outcome, 'REJECTED');
  assert.equal(res5.reason, 'NO_COLLATERAL');

  // 6. Determinism: evaluate 100 times, always identical canonical string
  const canonicalRes = canonical(res1);
  for (let i = 0; i < 100; i++) {
    assert.equal(canonical(evaluatePolicy({ collateral: '100', debt: '0' }, { borrowAmountAtomic: '80' }, policy)), canonicalRes);
  }
});

test('[TASK-03] 상태 스냅샷 및 결정 레코드 스키마 무결성 검증', async () => {
  const f = creditFixture();
  const request = f.createRequest('80');

  // Validate request
  const validatedReq = validateRequest(request, f.trust);
  assert.equal(validatedReq.borrowAmountAtomic, '80');
  assert.equal(validatedReq.subject, f.alice);

  // State snapshot
  const snapshot = stateSnapshot({
    chainId: '31337',
    blockNumber: '1234',
    blockHash: '0x' + 'bb'.repeat(32),
    targetContract: f.creditStateAddress,
    subject: f.alice,
    collateral: '100',
    debt: '0'
  });
  assert.equal(snapshot.collateral, '100');
  assert.equal(snapshot.debt, '0');

  // Mock reader that returns this snapshot
  const mockReader = {
    creditState: async (ref, subject, contract) => ({ collateral: '100', debt: '0' })
  };

  const ref = receiptRef({ batchId: '1', blockNumber: '1234', blockHash: '0x' + 'bb'.repeat(32) }, 0);
  const { record: decision, snapshot: createdSnapshot } = await makeDecision(
    request,
    ref,
    f.trust,
    mockReader,
    'trust-lending',
    f.institution.privateKey
  );

  assert.equal(decision.kind, 'DECISION');
  assert.equal(decision.decision.payload.outcome, 'REJECTED');
  assert.equal(decision.decision.payload.reason, 'LTV_EXCEEDED');
  assert.equal(decision.decision.payload.derived.ltvBps, 8000);

  // Validate decision
  const validatedDecision = await validateDecision(
    decision,
    request,
    ref,
    createdSnapshot,
    f.trust,
    mockReader
  );
  assert.equal(validatedDecision.outcome, 'REJECTED');
});
