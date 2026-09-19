import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLocalBaseline } from '../../scripts/deploy-local.js';
import { RpcRuntimeAdapter } from '../../src/v3/rpc-runtime.js';
import { anchorCall } from '../../src/v3/chain.js';

test('TASK-05: direct RPC Runtime Adapter smoke test (Gate: Block N reproduction & Execution Harness)', async () => {
  const env = await setupLocalBaseline();
  const runtime = new RpcRuntimeAdapter({ rpcUrl: env.rpcUrl });

  try {
    // 1. Mutate state to 200 at a later block
    await env.setCreditState(env.aliceAddress, 200n, 0n);

    // 2. direct RPC Replay Smoke Test at Block N
    const replayed = await runtime.replayStateAtBlock({
      blockNumber: env.blockNumber,
      targetContract: env.creditStateAddress,
      subject: env.aliceAddress
    });

    // GATE 1: blockHash matches
    assert.equal(replayed.blockHash, env.blockHash, 'Gate 1: blockHash must match baseline');
    // GATE 2: collateral matches 100 (not mutated 200)
    assert.equal(replayed.collateral, '100', 'Gate 2: collateral must match 100 at block N');
    // GATE 3: debt matches 0
    assert.equal(replayed.debt, '0', 'Gate 3: debt must match 0');
    await assert.rejects(runtime.replayStateAtBlock({
      blockNumber: env.blockNumber, blockHash: '0x' + '00'.repeat(32),
      targetContract: env.creditStateAddress, subject: env.aliceAddress
    }), /REORG/);
    const remote = new RpcRuntimeAdapter({ rpcUrl: 'https://sepolia.base.org', chainId: 84532 });
    await assert.rejects(remote.stageAndBroadcast({}), /LOCAL_SIGNING_ONLY/);
    const wrongChain = new RpcRuntimeAdapter({ rpcUrl: env.rpcUrl, chainId: 84532 });
    await assert.rejects(wrongChain.replayStateAtBlock({
      blockNumber: env.blockNumber, targetContract: env.creditStateAddress, subject: env.aliceAddress
    }), /CHAIN_MISMATCH/);

    // Reject 'latest'
    await assert.rejects(
      async () => {
        await runtime.replayStateAtBlock({
          blockNumber: 'latest',
          targetContract: env.creditStateAddress,
          subject: env.aliceAddress
        });
      },
      /HISTORICAL_BLOCK_REQUIRED_NOT_LATEST/
    );

    // 3. direct RPC Execution Harness Smoke Test: Simulate, Sign & Broadcast anchorBatch
    const dummyRoot = '0x' + '44'.repeat(32);
    const dummyBatch = { batchId: '1', root: dummyRoot, count: 1 };
    const dummyTrust = { policy: { chainId: '31337', anchorAddress: env.recordAnchorAddress } };
    const tx = anchorCall(dummyBatch, dummyTrust);

    // Standard Anvil account 0 private key
    const deployerPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const broadcastResult = await runtime.stageAndBroadcast({
      to: tx.to,
      data: tx.data,
      privateKey: deployerPrivateKey
    });

    assert.equal(broadcastResult.status, 'success', 'Anchor transaction via direct RPC must succeed');
    assert.ok(broadcastResult.transactionHash, 'Tx hash must be returned');
  } finally {
    await env.teardown();
  }
});
