import { createPublicClient, createWalletClient, http, encodeFunctionData, decodeFunctionResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { check, hashShape, addressShape } from './crypto.js';
import { creditStateAbi, quantity } from './chain.js';

/**
 * Direct RPC prototype. Does not call Aomi, create a fork, enforce Aomi
 * permissions, or sponsor gas. Signing is restricted to the local test chain.
 *
 * Reads two historical contract values and preflights local anchor transactions.
 */
export class RpcRuntimeAdapter {
  constructor({ rpcUrl, chainId = 31337 } = {}) {
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.client = createPublicClient({ transport: http(rpcUrl) });
  }

  /**
   * Replays and reads CreditState specifically at historical blockNumber.
   * @param {Object} params
   * @param {string|number} params.blockNumber Historical block number
   * @param {string} params.targetContract CreditState address
   * @param {string} params.subject User address
   * @returns {Promise<{ collateral: string, debt: string, blockNumber: string, blockHash: string }>}
   */
  async replayStateAtBlock({ blockNumber, blockHash, targetContract, subject }) {
    check(blockNumber !== undefined && blockNumber !== null, 'BLOCK_NUMBER_REQUIRED');
    check(blockNumber !== 'latest', 'HISTORICAL_BLOCK_REQUIRED_NOT_LATEST');
    check(addressShape(targetContract), 'INVALID_TARGET_CONTRACT');
    check(addressShape(subject), 'INVALID_SUBJECT');

    const bn = typeof blockNumber === 'bigint' ? blockNumber : BigInt(blockNumber);
    check(await this.client.getChainId() === this.chainId, 'CHAIN_MISMATCH');
    const block = await this.client.getBlock({ blockNumber: bn });
    check(block && hashShape(block.hash), 'BLOCK_UNAVAILABLE');
    if (blockHash !== undefined) check(block.hash === blockHash, 'REORG');
    const pinned = { blockHash: block.hash, requireCanonical: true };
    const read = async functionName => {
      const data = encodeFunctionData({ abi: creditStateAbi, functionName, args: [subject] });
      const raw = await this.client.request({ method: 'eth_call', params: [{ to: targetContract, data }, pinned] });
      return decodeFunctionResult({ abi: creditStateAbi, functionName, data: raw });
    };
    const [collateralRaw, debtRaw] = await Promise.all([read('collateralOf'), read('debtOf')]);
    const after = await this.client.request({ method: 'eth_getBlockByNumber', params: [quantity(bn), false] });
    check(after?.hash === block.hash, 'REORG');

    return {
      collateral: collateralRaw.toString(),
      debt: debtRaw.toString(),
      blockNumber: bn.toString(),
      blockHash: block.hash
    };
  }

  /**
   * Execution Harness: Simulates, signs, and broadcasts anchorBatch tx.
   * @param {Object} params
   * @param {string} params.to Target RecordAnchor address
   * @param {string} params.data Exact ABI calldata
   * @param {string} params.privateKey Signer private key
   * @returns {Promise<{ transactionHash: string, blockNumber: string, status: string }>}
   */
  async stageAndBroadcast({ to, data, privateKey }) {
    const url = new URL(this.rpcUrl);
    check(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && this.chainId === 31337,
      'LOCAL_SIGNING_ONLY');
    check(await this.client.getChainId() === 31337, 'CHAIN_MISMATCH');
    check(addressShape(to), 'INVALID_ANCHOR_ADDRESS');
    check(typeof data === 'string' && data.startsWith('0x'), 'INVALID_CALLDATA');

    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({ account, chain: foundry, transport: http(this.rpcUrl) });

    // Direct eth_call preflight, not an Aomi managed-fork simulation.
    await this.client.call({
      account: account.address,
      to,
      data
    });

    // Step 2: Sign and broadcast
    const hash = await wallet.sendTransaction({
      to,
      data
    });

    // Step 3: Wait for settlement
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    check(receipt.status === 'success', 'ANCHOR_TRANSACTION_FAILED');

    return {
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status
    };
  }
}
