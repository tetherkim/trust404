import { jsonRpc } from '../src/v3/chain.js';
import { check } from '../src/v3/crypto.js';

// Read-only: no key, wallet, faucet, or transaction submission is involved.
const rpc = jsonRpc(process.env.TESTNET_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com');
try {
  const chainId = BigInt(await rpc('eth_chainId', [])).toString();
  check(chainId === (process.env.TESTNET_CHAIN_ID ?? '11155111'), 'CHAIN_MISMATCH');
  const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
  check(block?.hash, 'FINALITY_UNAVAILABLE');
  const address = '0x0000000000000000000000000000000000000000';
  const pinned = { blockHash: block.hash, requireCanonical: true };
  await rpc('eth_getCode', [address, pinned]);
  await rpc('eth_call', [{ to: address, data: '0x' }, pinned]);
  console.log(JSON.stringify({ ok: true, chainId, finalizedBlock: BigInt(block.number).toString(),
    blockHash: block.hash, blockHashReads: true, transactionsSent: 0,
    limitation: 'Checks recent finalized-block RPC support only; not old archive retention or Aomi execution.' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, transactionsSent: 0 })); process.exitCode = 1;
}
