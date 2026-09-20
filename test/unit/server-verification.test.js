import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as netServer } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setupLocalBaseline } from '../../scripts/deploy-local.js';
import { RpcRuntimeAdapter } from '../../src/chain/rpc-runtime.js';
import { Archive, EvidenceStore } from '../../src/storage/store.js';
import { createEvidenceServer } from '../../src/server/server.js';
import { hash, canonical } from '../../src/common/crypto.js';
import { scope, requestRecord } from '../../src/policy/policy.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (server?.listening) {
    await new Promise((res, rej) => server.close(err => (err ? rej(err) : res())));
  }
}

test('[TASK-10] HTTP 엔드포인트: GET /v3/requests/:id/verification 2계층 검증 JSON 반환 검증', async () => {
  const env = await setupLocalBaseline();
  const runtime = new RpcRuntimeAdapter({ rpcUrl: env.rpcUrl });
  const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  const workDir = mkdtempSync(join(tmpdir(), 'trust404-api-'));
  const archive = new Archive(join(workDir, 'archive'));

  const requester = generateKeyPairSync('ed25519');
  const institution = generateKeyPairSync('ed25519');
  const pub = key => key.export({ type: 'spki', format: 'pem' });

  const policy = {
    version: 3,
    logId: 'credit-log-api',
    chainId: '31337',
    anchorAddress: env.recordAnchorAddress,
    policyId: 'credit-ltv-v1',
    ruleVersion: 1,
    evaluatorVersion: 1,
    institutionId: 'trust-lending',
    creditStateAddress: env.creditStateAddress,
    maxLtvBps: '7000',
    decisionWindowSeconds: 90,
    stateRule: 'RECEIPT_BLOCK_END'
  };

  const trust = {
    policy,
    policyHash: hash('policy-v3', policy),
    publisher: env.publisherAddress,
    codeHash: '0x' + '33'.repeat(32),
    requesterKeys: { alice: pub(requester.publicKey) },
    institutionKeys: { 'trust-lending': pub(institution.publicKey) }
  };

  const store = new EvidenceStore(join(workDir, 'records.sqlite'), archive, trust);

  // Setup request & anchors
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
  store.submit(request);

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
      return runtime.replayStateAtBlock({
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
    finality: 'FINALIZED',
    at: async () => chainReader
  };

  // Prepare & anchor batch 1
  const b1 = await store.prepare({ assertCanonical: async () => {}, count: async () => '0', batch: async () => null });
  await runtime.stageAndBroadcast({ to: b1.transaction.to, data: b1.transaction.data, privateKey: deployerKey });

  // Decide
  await store.decide(request.requestId, chainReader, 'trust-lending', institution.privateKey);

  // Prepare & anchor batch 2
  const b2 = await store.prepare({ ...chainReader, count: async () => '1' });
  await runtime.stageAndBroadcast({ to: b2.transaction.to, data: b2.transaction.data, privateKey: deployerKey });

  // Mutate on chain
  await env.setCreditState(env.aliceAddress, 200n, 0n);

  const writeToken = randomBytes(32).toString('hex');
  const server = createEvidenceServer({
    store,
    reader: chainReader,
    writeToken,
    signer: { keyId: 'trust-lending', privateKey: institution.privateKey },
    runtime
  });

  const port = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v3/requests/${request.requestId}/verification`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.status, 'VERIFIED');
    assert.equal(data.recordIntegrity.requestSignature, 'VALID');
    assert.equal(data.recordIntegrity.decisionSignature, 'VALID');
    assert.equal(data.recordIntegrity.onchainRoots, 'MATCH');
    assert.equal(data.replay.state, 'MATCH');
    assert.equal(data.replay.policy, 'MATCH');
    assert.equal(data.replay.outcome, 'MATCH');
    assert.equal(data.decision.outcome, 'REJECTED');
    assert.equal(data.decision.reason, 'LTV_EXCEEDED');
  } finally {
    await closeServer(server);
    store.close();
    await env.teardown();
  }
});
