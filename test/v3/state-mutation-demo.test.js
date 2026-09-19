import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setupLocalBaseline } from '../../scripts/deploy-local.js';
import { AomiRuntimeAdapter } from '../../src/v3/aomi.js';
import { Archive, EvidenceStore } from '../../src/v3/store.js';
import { ChainReader, anchorCall } from '../../src/v3/chain.js';
import { hash, canonical, sign } from '../../src/v3/crypto.js';
import { scope, requestRecord, receiptRef } from '../../src/v3/policy.js';
import { verifyOne } from '../../src/v3/verify.js';

test('TASK-06 to TASK-09: State Mutation Demo & Two-Layer Verification with Aomi', async () => {
  const env = await setupLocalBaseline();
  const aomi = new AomiRuntimeAdapter({ rpcUrl: env.rpcUrl });
  const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  const workDir = mkdtempSync(join(tmpdir(), 'trust404-demo-'));
  const archive = new Archive(join(workDir, 'archive'));

  const requester = generateKeyPairSync('ed25519');
  const institution = generateKeyPairSync('ed25519');
  const pub = key => key.export({ type: 'spki', format: 'pem' });

  const policy = {
    version: 3,
    logId: 'credit-log-demo',
    chainId: '31337',
    anchorAddress: env.recordAnchorAddress,
    policyId: 'credit-ltv-v1',
    ruleVersion: 1,
    evaluatorVersion: 1,
    institutionId: 'trust-lending',
    creditStateAddress: env.creditStateAddress,
    maxLtvBps: '7000', // 70.00%
    decisionWindowSeconds: 90,
    stateRule: 'RECEIPT_BLOCK_END'
  };

  const trust = {
    policy,
    policyHash: hash('policy-v3', policy),
    publisher: env.publisherAddress,
    codeHash: '0x' + '33'.repeat(32), // dummy for local store
    requesterKeys: { alice: pub(requester.publicKey) },
    institutionKeys: { 'trust-lending': pub(institution.publicKey) }
  };

  const store = new EvidenceStore(join(workDir, 'records.sqlite'), archive, trust);

  try {
    // 1. Submit Request: Alice requests borrowing 80 (against 100 collateral at Block N)
    const request = requestRecord(
      {
        ...scope(policy),
        requesterId: 'alice',
        institutionId: policy.institutionId,
        subject: env.aliceAddress,
        creditStateAddress: env.creditStateAddress,
        borrowAmountAtomic: '80',
        createdAtMs: String(Date.now()),
        policyHash: trust.policyHash
      },
      'alice',
      requester.privateKey
    );
    const subResult = store.submit(request);
    assert.equal(subResult.duplicate, false);

    // 2. Prepare Batch 1 & Anchor via Aomi Harness
    const mockChainViewInitial = {
      assertCanonical: async () => {},
      count: async () => '0',
      batch: async () => null
    };
    const batch1Prep = await store.prepare(mockChainViewInitial);
    assert.equal(batch1Prep.batchId, '1');

    // Broadcast batch 1 on chain via Aomi
    const broadcast1 = await aomi.stageAndBroadcast({
      to: batch1Prep.transaction.to,
      data: batch1Prep.transaction.data,
      privateKey: deployerKey
    });
    assert.equal(broadcast1.status, 'success');

    // 3. Decide: Reader accesses Block N state via Aomi -> Evaluates -> Creates Decision
    // Mock chain view matching on-chain RecordAnchor
    const chainReader = {
      assertCanonical: async () => {},
      batch: async id => {
        const [root, count, bn, time] = await env.client.readContract({
          address: env.recordAnchorAddress,
          abi: [
            {
              name: 'batches',
              type: 'function',
              inputs: [{ type: 'uint256' }],
              outputs: [
                { name: 'root', type: 'bytes32' },
                { name: 'count', type: 'uint256' },
                { name: 'blockNumber', type: 'uint256' },
                { name: 'anchoredAt', type: 'uint256' }
              ],
              stateMutability: 'view'
            }
          ],
          functionName: 'batches',
          args: [BigInt(id)]
        });
        const block = await env.client.getBlock({ blockNumber: bn });
        return {
          batchId: String(id),
          root,
          count: Number(count),
          blockNumber: bn.toString(),
          blockHash: block.hash,
          anchoredAt: time.toString()
        };
      },
      creditState: async (ref, subject, contract) => {
        // Reads via Aomi at specific block N
        return aomi.replayStateAtBlock({
          blockNumber: env.blockNumber,
          targetContract: contract,
          subject
        });
      },
      context: {
        timestamp: String(Date.now()),
        blockNumber: env.blockNumber,
        blockHash: env.blockHash
      },
      finality: 'FINALIZED'
    };

    const decisionRecord = await store.decide(
      request.requestId,
      chainReader,
      'trust-lending',
      institution.privateKey
    );
    assert.equal(decisionRecord.kind, 'DECISION');
    assert.equal(decisionRecord.decision.payload.outcome, 'REJECTED');
    assert.equal(decisionRecord.decision.payload.reason, 'LTV_EXCEEDED');

    // 4. Prepare Batch 2 (Decision) & Anchor via Aomi Harness
    const mockChainViewBatch2 = {
      ...chainReader,
      count: async () => '1'
    };
    const batch2Prep = await store.prepare(mockChainViewBatch2);
    assert.equal(batch2Prep.batchId, '2');

    const broadcast2 = await aomi.stageAndBroadcast({
      to: batch2Prep.transaction.to,
      data: batch2Prep.transaction.data,
      privateKey: deployerKey
    });
    assert.equal(broadcast2.status, 'success');

    // 5. Bundle item for verification
    const bundle = store.bundle(request.requestId);
    assert.ok(bundle.request);
    assert.ok(bundle.decision);
    assert.ok(bundle.snapshot);

    // 6. [CRITICAL STEP] STATE MUTATION ON CHAIN:
    // Update Alice's collateral to 200 on the live chain!
    // In current state: borrow 80 / 200 = 40% <= 70% (would be approved).
    await env.setCreditState(env.aliceAddress, 200n, 0n);
    const liveLatest = await aomi.client.readContract({
      address: env.creditStateAddress,
      abi: [{ name: 'collateralOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'collateralOf',
      args: [env.aliceAddress]
    });
    assert.equal(liveLatest.toString(), '200');

    // 7. Verify Two Layers via Aomi Replay!
    const vResult = await verifyOne(bundle, trust, chainReader, aomi);

    assert.equal(vResult.ok, true);
    assert.equal(vResult.status, 'VERIFIED');
    assert.equal(vResult.recordIntegrity.requestSignature, 'VALID');
    assert.equal(vResult.recordIntegrity.decisionSignature, 'VALID');
    assert.equal(vResult.recordIntegrity.onchainRoots, 'MATCH');
    assert.equal(vResult.replay.state, 'MATCH');
    assert.equal(vResult.replay.policy, 'MATCH');
    assert.equal(vResult.replay.outcome, 'MATCH');
    assert.equal(vResult.outcome, 'REJECTED');
    assert.equal(vResult.reason, 'LTV_EXCEEDED');

    // 8. Test Failure Cases
    // Case A: Tampered decision outcome
    const tamperedBundle = structuredClone(bundle);
    tamperedBundle.decision.record.decision.payload.outcome = 'APPROVED';
    await assert.rejects(
      async () => {
        await verifyOne(tamperedBundle, trust, chainReader, aomi);
      },
      /INVALID_INCLUSION|INVALID_SIGNATURE/
    );

    // Case B: Policy mismatch (e.g. policy changed to 90% LTV)
    const alteredPolicyTrust = structuredClone(trust);
    alteredPolicyTrust.policy.maxLtvBps = '9000';
    alteredPolicyTrust.policyHash = hash('policy-v3', alteredPolicyTrust.policy);
    await assert.rejects(
      async () => {
        await verifyOne(bundle, alteredPolicyTrust, chainReader, aomi);
      },
      /POLICY_MISMATCH|REQUEST_CONTEXT_MISMATCH|DECISION_CONTEXT_MISMATCH/
    );

    // Case C: State snapshot tampering
    const tamperedSnapshotBundle = structuredClone(bundle);
    tamperedSnapshotBundle.snapshot.collateral = '150';
    await assert.rejects(
      async () => {
        await verifyOne(tamperedSnapshotBundle, trust, chainReader, aomi);
      },
      /STATE_HASH_MISMATCH/
    );
  } finally {
    store.close();
    await env.teardown();
  }
});
