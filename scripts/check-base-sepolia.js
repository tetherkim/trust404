import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { encodeFunctionData, parseAbi } from 'viem';
import { jsonRpc } from '../src/common/rpc.js';
import { check, addressShape } from '../src/common/crypto.js';

// Read-only readiness check. No private key is read and no transaction is sent.
export async function checkBaseSepolia(env) {
  const expected = env.CHAIN_ID ?? '84532';
  check(expected === '84532', 'BASE_SEPOLIA_REQUIRED');
  const rpc = jsonRpc(env.RPC_URL || 'https://sepolia.base.org');
  check(BigInt(await rpc('eth_chainId', [])) === 84532n, 'CHAIN_MISMATCH');
  const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
  check(block?.hash, 'FINALITY_UNAVAILABLE');
  const pinned = { blockHash: block.hash, requireCanonical: true };
  const zero = '0x0000000000000000000000000000000000000000';
  await rpc('eth_getCode', [zero, pinned]);
  await rpc('eth_call', [{ to: zero, data: '0x' }, pinned]);
  const result = { chainId: 84532, finalizedBlock: BigInt(block.number).toString(), blockHash: block.hash,
    blockHashReads: true, wallet: null, token: null, transactionsSent: 0, aomiExecutionVerified: false };
  if (env.WALLET_ADDRESS) {
    check(addressShape(env.WALLET_ADDRESS.toLowerCase()), 'INVALID_WALLET');
    result.wallet = { address: env.WALLET_ADDRESS,
      gasBalanceWei: BigInt(await rpc('eth_getBalance', [env.WALLET_ADDRESS, pinned])).toString() };
  }
  if (env.TEST_TOKEN_ADDRESS) {
    check(addressShape(env.TEST_TOKEN_ADDRESS.toLowerCase()), 'INVALID_TOKEN');
    check(await rpc('eth_getCode', [env.TEST_TOKEN_ADDRESS, pinned]) !== '0x', 'TOKEN_NOT_DEPLOYED');
    result.token = { address: env.TEST_TOKEN_ADDRESS };
    if (result.wallet) {
      const data = encodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf', args: [env.WALLET_ADDRESS] });
      result.token.balanceAtomic = BigInt(await rpc('eth_call', [{ to: env.TEST_TOKEN_ADDRESS, data }, pinned])).toString();
    }
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = new URL('../.env', import.meta.url);
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const env = Object.fromEntries(['RPC_URL', 'CHAIN_ID', 'WALLET_ADDRESS', 'TEST_TOKEN_ADDRESS']
    .map(key => [key, process.env[key] ?? file[key]]));
  checkBaseSepolia(env).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, error: /^[A-Z_]+$/.test(error.message) ? error.message : 'CHECK_FAILED', transactionsSent: 0 }));
    process.exitCode = 1;
  });
}
