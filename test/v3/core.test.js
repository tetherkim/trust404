import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, parseWire, sign } from '../../src/v3/crypto.js';
import { evaluate, validateRequest } from '../../src/v3/policy.js';
import { buildTree, verifyProof } from '../../src/v3/merkle.js';
import { auditAll, verifyOne, timing } from '../../src/v3/verify.js';
import { fixture, paired } from './fixtures.js';

test('정규 JSON 통신: 중복 키 거부, 요청 식별자 및 서명이 모든 필드를 바인딩', () => {
  assert.throws(() => parseWire('{"a":1,"a":2}'));
  const f = fixture(), a = f.request();
  assert.deepEqual(a, f.request());
  assert.notEqual(a.requestId, f.request('50000000', '2').requestId);
  a.request.payload.amountAtomic = '1';
  assert.throws(() => validateRequest(a, f.trust), /SIGNATURE/);
});
test('정책 평가: 정수 엄격성 및 명시적 경계값(한도/준비금) 규칙 준수', () => {
  const p = fixture().trust.policy;
  assert.equal(evaluate('100000001', null, p).reason, 'LIMIT_EXCEEDED');
  assert.equal(evaluate('50000000', '150000000', p).outcome, 'APPROVED');
  assert.equal(evaluate('50000000', '149999999', p).outcome, 'REJECTED');
  assert.throws(() => evaluate('50000000', null, p), /STATE_UNAVAILABLE/);
  assert.equal(timing({ anchoredAt: '100' }, null, { timestamp: '190' }), 'PENDING');
  assert.equal(timing({ anchoredAt: '100' }, null, { timestamp: '191' }), 'MISSING_AS_OF_H');
});
test('순서화 머클 증명: 모든 배치 크기 지원 및 리프/인덱스/경로 변조 감지', () => {
  for (let n = 1; n <= 32; n++) {
    const records = Array.from({ length: n }, (_, index) => ({ index })), tree = buildTree(records);
    for (let i = 0; i < n; i++) {
      verifyProof(records[i], i, n, tree.proof(i), tree.root);
      assert.throws(() => verifyProof({ index: 99 }, i, n, tree.proof(i), tree.root));
      if (n > 1) assert.throws(() => verifyProof(records[i], (i + 1) % n, n, tree.proof(i), tree.root));
    }
    const old = tree.root; records[0].index = 90; assert.equal(tree.root, old);
  }
});
test('단건 검증과 전수 감사에서 동일한 거절 사유 재현', async () => {
  const f = await paired();
  assert.equal((await verifyOne(f.bundle, f.trust, f.chain)).reason, 'RESERVE_FLOOR');
  const all = await auditAll(f.archive, f.trust, f.chain);
  assert.equal(all.ok, true); assert.equal(all.requests[0].decisions[0].reason, 'RESERVE_FLOOR');
});
test('유효하게 서명된 허위 결정과 상충하는 결정문 각각 분리 탐지', async () => {
  const f = await paired();
  const payload = { ...f.decision.decision.payload, outcome: 'APPROVED', reason: 'POLICY_SATISFIED' };
  const wrong = { kind: 'DECISION', decision: sign('decision-v3', 'company', payload, f.institution.privateKey) };
  f.batches.push([wrong]); f.chain.add([wrong], 120);
  const all = await auditAll(f.archive, f.trust, f.chain);
  assert.equal(all.ok, false);
  assert(all.issues.some(x => x.code === 'POLICY_MISMATCH'));
  assert(all.issues.some(x => x.code === 'CONFLICTING_DECISIONS'));
});
test('변조, 아카이브 유실, 결정 누락 시 각각 구분된 오류 결과 반환', async () => {
  const f = await paired();
  f.chain.timestamp = 200; f.chain.batches.pop(); f.batches.pop();
  let all = await auditAll(f.archive, f.trust, f.chain);
  assert.equal(all.complete, true); assert.equal(all.requests[0].timing, 'MISSING_AS_OF_H');
  f.chain.add([f.decision], 110);
  all = await auditAll({ ...f.archive, batch: id => { if (id === '2') throw Error(); return f.batches[0]; } }, f.trust, f.chain);
  assert.equal(all.complete, false); assert.equal(all.requests[0].timing, 'UNKNOWN');
  all = await auditAll({ ...f.archive, batch: () => [] }, f.trust, f.chain);
  assert(all.issues.every(x => x.code === 'TAMPERED_EXPORT'));
});
test('스냅샷 변조, RPC 장애, 체인 리오그(Reorg) 발생 시 검증 통과 불가', async () => {
  const f = await paired();
  f.bundle.snapshot = { ...f.snapshot, balanceAtomic: '200000000' };
  await assert.rejects(verifyOne(f.bundle, f.trust, f.chain), /STATE_HASH_MISMATCH/);
  f.bundle.snapshot = f.snapshot;
  f.chain.balance = async () => { throw Error('RPC_UNAVAILABLE'); };
  const all = await auditAll(f.archive, f.trust, f.chain); assert.equal(all.complete, false);
  f.chain.assertCanonical = async () => { throw Error('REORG'); };
  await assert.rejects(verifyOne(f.bundle, f.trust, f.chain), /REORG/);
});

test('JCS 정규화: 유효하지 않은 유니코드(단독 대행 코드) 거부', () => {
  assert.throws(() => canonical({ value: '\ud800' }), /INVALID_UNICODE/);
  assert.throws(() => canonical({ ['\udfff']: 'value' }), /INVALID_UNICODE/);
});
