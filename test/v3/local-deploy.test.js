import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLocalBaseline } from '../../scripts/deploy-local.js';

test('[TASK-04] 로컬 Anvil 체인 배포: CreditState 및 RecordAnchor 배포, N번 블록 기준선 캡처, RPC 조회 검증', async () => {
  const env = await setupLocalBaseline();
  try {
    assert.ok(env.creditStateAddress, 'creditStateAddress should be set');
    assert.ok(env.recordAnchorAddress, 'recordAnchorAddress should be set');
    assert.ok(env.blockNumber, 'blockNumber should be captured');
    assert.ok(env.blockHash, 'blockHash should be captured');

    // Verify baseline historical read at Block N
    const stateAtN = await env.readCreditStateAtBlock(env.blockNumber, env.aliceAddress);
    assert.equal(stateAtN.collateral, '100', 'collateral at block N must be 100');
    assert.equal(stateAtN.debt, '0', 'debt at block N must be 0');

    // Mutate state in a later block to 200
    await env.setCreditState(env.aliceAddress, 200n, 0n);
    const stateLatest = await env.readCreditStateAtBlock('latest', env.aliceAddress);
    assert.equal(stateLatest.collateral, '200', 'collateral at latest must be 200');

    // Crucial check: reading at historical block N STILL yields 100!
    const stateReplayed = await env.readCreditStateAtBlock(env.blockNumber, env.aliceAddress);
    assert.equal(stateReplayed.collateral, '100', 'historical block N read must remain 100');
    assert.equal(stateReplayed.debt, '0', 'historical block N read must remain 0');
  } finally {
    await env.teardown();
  }
});
