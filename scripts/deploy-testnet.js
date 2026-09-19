import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { jsonRpc, creditStateAbi, anchorAbi } from '../src/v3/chain.js';
import { check } from '../src/v3/crypto.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function loadEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      env[k] = v;
    }
  }
  return env;
}

const artifact = (file, name) => JSON.parse(readFileSync(join(root, 'out', file, `${name}.json`), 'utf8'));

export async function runTestnetCheck() {
  const env = loadEnv();
  const rpcUrl = env.RPC_URL || 'https://sepolia.base.org';
  const expectedChainId = env.CHAIN_ID ? BigInt(env.CHAIN_ID) : 84532n;

  console.log('--- Testnet Connection Check ---');
  console.log(`RPC URL: ${rpcUrl}`);
  console.log(`Expected Chain ID: ${expectedChainId}`);

  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl)
  });

  const chainId = await client.getChainId();
  console.log(`Connected Chain ID: ${chainId}`);
  check(BigInt(chainId) === expectedChainId, 'CHAIN_ID_MISMATCH');

  const blockNumber = await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber });
  console.log(`Current Block Number: ${blockNumber}`);
  console.log(`Current Block Hash: ${block.hash}`);

  if (env.WALLET_ADDRESS) {
    console.log(`Wallet Address: ${env.WALLET_ADDRESS}`);
    const ethBalance = await client.getBalance({ address: env.WALLET_ADDRESS });
    console.log(`ETH Balance: ${formatUnits(ethBalance, 18)} ETH`);
  }

  if (env.TEST_TOKEN_ADDRESS) {
    console.log(`Test Token Address: ${env.TEST_TOKEN_ADDRESS}`);
    if (env.WALLET_ADDRESS) {
      try {
        const tokenBalance = await client.readContract({
          address: env.TEST_TOKEN_ADDRESS,
          abi: [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
          functionName: 'balanceOf',
          args: [env.WALLET_ADDRESS]
        });
        console.log(`Token Balance of Wallet: ${tokenBalance.toString()}`);
      } catch (e) {
        console.log(`Note: Could not query token balance (${e.message})`);
      }
    }
  }

  return {
    chainId,
    blockNumber: blockNumber.toString(),
    blockHash: block.hash,
    rpcUrl,
    client
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTestnetCheck()
    .then(() => {
      console.log('Testnet check completed successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('Testnet check failed:', err.message);
      process.exit(1);
    });
}
