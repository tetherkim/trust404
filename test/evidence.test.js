import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystem, verifySingle, audit, sign, hash, merkle, proof, verifyProof } from '../src/evidence.js';

function fixture() {
  const s = createSystem();
  const request = s.submit('req-1', 1500000, 1000);
  const decision = s.decide(request, 1001);
  const trust = s.trust(1100);
  return { s, request, decision, trust, bundle: s.bundle(request, decision, trust) };
}
test('[R3] 한도 경계값 검증: 한도 초과 시 거절, 미만 시 승인', () => {
  for (const amount of [999999, 1000000, 1000001]) {
    const s = createSystem();
    const r = s.submit(String(amount), amount, 1000);
    assert.equal(s.decide(r, 1001).evidence.payload.outcome, amount > 1000000 ? 'REJECTED' : 'APPROVED');
  }
});
test('[R1–R5] 단건 독립 증거 검증: 기관 DB 없이 거절 레코드의 유효성 검증', () => {
  const { bundle, trust } = fixture();
  assert.equal(verifySingle(bundle, trust).outcome, 'REJECTED');
});
test('[R1,R3–R5] 위변조 탐지: 요청 금액, 사유 및 서명 변조 시 검증 실패', () => {
  const { bundle, trust } = fixture();
  for (const change of [b => b.request.entry.evidence.payload.amount++, b => b.decision.entry.evidence.payload.reason = 'OTHER', b => b.decision.entry.evidence.signature = 'AAAA']) {
    const b = structuredClone(bundle); change(b);
    assert.throws(() => verifySingle(b, trust));
  }
});
test('[R3,R5] 부인 방지: 기관의 유효한 서명이 있더라도 허위 결정은 정책 불일치로 실패', () => {
  const { s, request, decision } = fixture();
  decision.evidence = sign('decision', { ...decision.evidence.payload, outcome: 'APPROVED', reason: 'WITHIN_LIMIT' }, s.keys.institution.privateKey);
  const trust = s.trust(1100);
  assert.throws(() => verifySingle(s.bundle(request, decision, trust), trust), /POLICY_MISMATCH/);
});
test('[R6] 완전성 감사: 승인 및 거절을 모두 포함하는 전체 로그 감사 성공', () => {
  const { s } = fixture();
  const r = s.submit('req-2', 500000, 1002); s.decide(r, 1003);
  assert.deepEqual(audit(s.entries, s.trust(1100)), { ok: true, requests: 2, decisions: 2, pending: [], overdue: [] });
});
test('[R4,R6] 무결성 감사: 삭제, 순서 변경, 중복 레코드 조작 탐지', () => {
  const { s, trust } = fixture();
  for (const entries of [s.entries.slice(1), [...s.entries].reverse(), [s.entries[0], s.entries[0]]]) assert.throws(() => audit(entries, trust));
});
test('[R2,R6] 결정 누락 탐지: 기한 내에는 보류(pending), 기한 초과 시 기한초과(overdue)', () => {
  const s = createSystem(); s.submit('forgotten', 100, 1000);
  assert.deepEqual(audit(s.entries, s.trust(1059)).pending, ['forgotten']);
  const result = audit(s.entries, s.trust(1060));
  assert.equal(result.ok, false); assert.deepEqual(result.overdue, ['forgotten']);
});
test('[R1] 입력 검증: 유효하지 않은 금액 및 중복 요청 ID 거부', () => {
  const s = createSystem();
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => s.submit('bad', amount, 1000));
  s.submit('unique', 1, 1000); assert.throws(() => s.submit('unique', 1, 1000));
});
test('[R1] 문맥 일치 검증: 고객 서명이 있더라도 다른 기관 또는 다른 정책은 거부', () => {
  for (const field of ['institution', 'policyHash']) {
    const { s, request } = fixture();
    request.evidence = sign('request', { ...request.evidence.payload, [field]: 'other' }, s.keys.customer.privateKey);
    assert.throws(() => audit(s.entries, s.trust(1100)));
  }
});
test('[R5,R6] 신뢰 기준 검증: 검증 키 교체, 체크포인트 변조, 과거 감사 범위 불일치 시 실패', () => {
  const { s, bundle, trust } = fixture();
  const other = createSystem();
  assert.throws(() => verifySingle(bundle, { ...trust, witnessKey: other.trust(1100).witnessKey }));
  s.submit('new', 1, 1101);
  assert.throws(() => verifySingle(bundle, s.trust(1102)), /CHECKPOINT/);
  assert.throws(() => audit([], trust));
});
test('[R4,R5] 머클 경로 검증: 배치 크기, 인덱스, 방향, 데이터 바인딩 검증', () => {
  for (let size = 1; size <= 17; size++) {
    const entries = Array.from({ length: size }, (_, index) => ({ index }));
    const root = merkle(entries);
    for (let index = 0; index < size; index++) {
      const p = proof(entries, index);
      assert.equal(verifyProof(entries[index], index, size, p, root), true);
      assert.equal(verifyProof({ index: -1 }, index, size, p, root), false);
      assert.equal(verifyProof(entries[index], size, size, p, root), false);
      assert.equal(verifyProof(entries[index], index, size, [...p, { side: 'left', hash: hash('fake') }], root), false);
    }
  }
});
test('[R1,R3] 서명 무결성: 온체인 앵커링된 로그 내부라도 유효하지 않은 서명은 거부', () => {
  for (const role of ['customer', 'institution']) {
    const { s, request, decision } = fixture();
    const target = role === 'customer' ? request : decision;
    target.evidence = sign(target.evidence.domain, target.evidence.payload, createSystem().keys[role].privateKey);
    const trust = s.trust(1100);
    assert.throws(() => verifySingle(s.bundle(request, decision, trust), trust), /INVALID_SIGNATURE/);
  }
});
test('[R2,R3] 원자성 보장: 영속화 저장 실패 시 확인 응답을 반환하거나 증거를 추가하지 않음', () => {
  const s = createSystem({ onAppend() { throw new Error('DISK_FAILURE'); } });
  assert.throws(() => s.submit('not-persisted', 1, 1000), /DISK_FAILURE/);
  assert.equal(s.entries.length, 0);
  const second = createSystem({ onAppend(entries) { if (entries.length > 1) throw new Error('DISK_FAILURE'); } });
  const request = second.submit('received', 1, 1000);
  assert.throws(() => second.decide(request, 1001), /DISK_FAILURE/);
  assert.equal(second.entries.length, 1);
});
