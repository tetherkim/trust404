import { createPublicClient, createWalletClient, http, encodeFunctionData, decodeFunctionResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { check, integer, hashShape, addressShape } from './crypto.js';
import { creditStateAbi, anchorAbi } from './chain.js';

/**
 * AomiRuntimeAdapter
 *
 * Provides the two core capabilities required for Track 03:
 * 1. Historical Replay Environment: Reproduces exact chain state at Block N.
 * 2. Execution Harness: Simulates, signs, and broadcasts RecordAnchor batch transactions.
 */
export class AomiRuntimeAdapter {
  constructor({ rpcUrl, chainId = 31337, aomiCliPath = null } = {}) {
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.aomiCliPath = aomiCliPath;
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
  async replayStateAtBlock({ blockNumber, targetContract, subject }) {
    check(blockNumber !== undefined && blockNumber !== null, 'BLOCK_NUMBER_REQUIRED');
    check(blockNumber !== 'latest', 'HISTORICAL_BLOCK_REQUIRED_NOT_LATEST');
    check(addressShape(targetContract), 'INVALID_TARGET_CONTRACT');
    check(addressShape(subject), 'INVALID_SUBJECT');

    const bn = typeof blockNumber === 'bigint' ? blockNumber : BigInt(blockNumber);
    const block = await this.client.getBlock({ blockNumber: bn });
    check(block && hashShape(block.hash), 'BLOCK_UNAVAILABLE');

    const [collateralRaw, debtRaw] = await Promise.all([
      this.client.readContract({
        address: targetContract,
        abi: creditStateAbi,
        functionName: 'collateralOf',
        args: [subject],
        blockNumber: bn
      }),
      this.client.readContract({
        address: targetContract,
        abi: creditStateAbi,
        functionName: 'debtOf',
        args: [subject],
        blockNumber: bn
      })
    ]);

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
    check(addressShape(to), 'INVALID_ANCHOR_ADDRESS');
    check(typeof data === 'string' && data.startsWith('0x'), 'INVALID_CALLDATA');

    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({ account, chain: foundry, transport: http(this.rpcUrl) });

    // Step 1: Simulate tx execution on fork/chain
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
