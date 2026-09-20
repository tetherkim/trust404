import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, encodeFunctionData, decodeFunctionResult } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { jsonRpc, creditStateAbi, anchorAbi } from '../src/v3/chain.js';
import { check } from '../src/v3/crypto.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (server?.listening) {
    await new Promise((res, rej) => server.close(err => (err ? rej(err) : res())));
  }
}

async function unusedPort() {
  const server = netServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

const artifact = (file, name) => JSON.parse(readFileSync(join(root, 'out', file, `${name}.json`), 'utf8'));

export async function setupLocalBaseline({ port, silent = true } = {}) {
  // Fail before spawning Anvil if a fresh checkout has not been compiled.
  const creditStateArtifact = artifact('CreditState.sol', 'CreditState');
  const anchorArtifact = artifact('RecordAnchor.sol', 'RecordAnchor');
  const rpcPort = port ?? (await unusedPort());
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const child = spawn(
    'anvil',
    ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '31337', '--silent'],
    { stdio: silent ? 'ignore' : 'inherit' }
  );

  let spawnError;
  child.on('error', err => {
    spawnError = err;
  });

  const teardown = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };

  try {

  const rpc = jsonRpc(rpcUrl, { timeoutMs: 3000 });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw new Error('ANVIL_UNAVAILABLE');
    try {
      if (BigInt(await rpc('eth_chainId', [])) === 31337n) {
        ready = true;
        break;
      }
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
  check(ready, 'LOCAL_CHAIN_UNAVAILABLE');

  const account = mnemonicToAccount('test test test test test test test test test test test junk');
  const alice = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 });

  const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
  const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

  const receipt = async txHash => {
    const tx = await client.waitForTransactionReceipt({ hash: txHash });
    check(tx.status === 'success', 'LOCAL_TRANSACTION_FAILED');
    return tx;
  };

  const deploy = async (compiled, args = []) => {
    const hash = await wallet.deployContract({
      abi: compiled.abi,
      bytecode: compiled.bytecode.object,
      args
    });
    const r = await receipt(hash);
    return r.contractAddress.toLowerCase();
  };

  const creditStateAddress = await deploy(creditStateArtifact, [account.address]);
  const recordAnchorAddress = await deploy(anchorArtifact, [account.address]);

  // Set Alice account state: collateral = 100, debt = 0
  const setStateHash = await wallet.writeContract({
    address: creditStateAddress,
    abi: creditStateAbi,
    functionName: 'setAccountState',
    args: [alice.address, 100n, 0n]
  });
  const setStateReceipt = await receipt(setStateHash);

  const blockNumber = setStateReceipt.blockNumber.toString();
  const block = await client.getBlock({ blockNumber: setStateReceipt.blockNumber });
  const blockHash = block.hash;

  const readCreditStateAtBlock = async (blockRef, subject) => {
    const blockParam = typeof blockRef === 'bigint' ? blockRef : (blockRef === 'latest' ? 'latest' : BigInt(blockRef));
    const [collateral, debt] = await Promise.all([
      client.readContract({
        address: creditStateAddress,
        abi: creditStateAbi,
        functionName: 'collateralOf',
        args: [subject],
        blockNumber: blockParam === 'latest' ? undefined : blockParam
      }),
      client.readContract({
        address: creditStateAddress,
        abi: creditStateAbi,
        functionName: 'debtOf',
        args: [subject],
        blockNumber: blockParam === 'latest' ? undefined : blockParam
      })
    ]);
    return { collateral: collateral.toString(), debt: debt.toString() };
  };

  const setCreditState = async (subject, collateral, debt) => {
    const txHash = await wallet.writeContract({
      address: creditStateAddress,
      abi: creditStateAbi,
      functionName: 'setAccountState',
      args: [subject, BigInt(collateral), BigInt(debt)]
    });
    return receipt(txHash);
  };

  const contextData = {
    chainId: 31337,
    rpcUrl,
    creditStateAddress,
    recordAnchorAddress,
    publisherAddress: account.address.toLowerCase(),
    aliceAddress: alice.address.toLowerCase(),
    blockNumber,
    blockHash,
    collateral: '100',
    debt: '0'
  };

  return {
    ...contextData,
    wallet,
    client,
    readCreditStateAtBlock,
    setCreditState,
    teardown
  };
  } catch (error) {
    await teardown();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Deploying local baseline on Anvil...');
  const env = await setupLocalBaseline({ silent: false });
  console.log('Baseline deployed successfully:');
  console.log(`CreditState: ${env.creditStateAddress}`);
  console.log(`RecordAnchor: ${env.recordAnchorAddress}`);
  console.log(`Block N: ${env.blockNumber} (${env.blockHash})`);
  const initial = await env.readCreditStateAtBlock(env.blockNumber, env.aliceAddress);
  console.log(`Initial Alice State: Collateral=${initial.collateral}, Debt=${initial.debt}`);
  await env.teardown();
  process.exit(0);
}
