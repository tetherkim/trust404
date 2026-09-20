import { encodeFunctionData, decodeFunctionResult, keccak256 } from 'viem';
import { check, integer, hashShape, canonical } from '../common/crypto.js';
import { quantity, jsonRpc } from '../common/rpc.js';
import { anchorAbi, tokenAbi, creditStateAbi } from '../common/abi.js';
import { validateTrust } from '../policy/policy.js';

export { anchorAbi, creditStateAbi, tokenAbi, quantity, jsonRpc };

/**
 * Reader for reading verified on-chain anchor batches and contract states.
 */
export class ChainReader {
  /**
   * @param {Function} rpc - JSON-RPC client function.
   * @param {object} trust - Trust configuration.
   */
  constructor(rpc, trust) {
    validateTrust(trust);
    this.rpc = rpc;
    this.trust = structuredClone(trust);
    this.reads = new Map();
  }

  /**
   * Creates an immutable ChainView pinned at a specific block number or hash.
   *
   * @param {string|number} [block='finalized'] - Block identifier ('finalized', 'latest', block number, or block hash).
   * @returns {Promise<ChainView>}
   */
  async at(block = 'finalized') {
    const { rpc, trust } = this;
    const currentChainId = BigInt(await rpc('eth_chainId', []));
    check(currentChainId === integer(trust.policy.chainId), 'CHAIN_MISMATCH');

    const blockMethod = hashShape(block) ? 'eth_getBlockByHash' : 'eth_getBlockByNumber';
    const blockHeader = await rpc(blockMethod, [block, false]);
    check(blockHeader && hashShape(blockHeader.hash), 'BLOCK_UNAVAILABLE');

    const view = new ChainView(this, blockHeader);
    await view.assertCanonical();

    const deployedCode = await rpc('eth_getCode', [
      trust.policy.anchorAddress,
      { blockHash: blockHeader.hash, requireCanonical: true }
    ]);
    check(
      deployedCode !== '0x' && keccak256(deployedCode) === trust.codeHash,
      'CONTRACT_MISMATCH'
    );

    const contractPublisher = await view.call('publisher');
    check(
      contractPublisher.toLowerCase() === trust.publisher,
      'PUBLISHER_MISMATCH'
    );

    const finalizedBlock = await rpc('eth_getBlockByNumber', ['finalized', false]);
    check(finalizedBlock, 'FINALITY_UNAVAILABLE');

    view.finality = BigInt(finalizedBlock.number) >= BigInt(blockHeader.number)
      ? 'FINALIZED'
      : 'PROVISIONAL';

    return view;
  }
}

/**
 * Pinned block view of the blockchain. Guarantees consistency against reorgs.
 */
export class ChainView {
  constructor(reader, blockHeader) {
    this.reader = reader;
    this.h = blockHeader;
    this.metas = new Map();
    this.context = {
      blockNumber: BigInt(blockHeader.number).toString(),
      blockHash: blockHeader.hash,
      timestamp: BigInt(blockHeader.timestamp).toString()
    };
  }

  /**
   * Asserts that the pinned block is canonical on the current chain tip.
   */
  async assertCanonical() {
    const currentHeader = await this.reader.rpc('eth_getBlockByNumber', [this.h.number, false]);
    check(currentHeader?.hash === this.h.hash, 'REORG');
  }

  /**
   * Retrieves a historical block header and verifies it is an ancestor of the pinned view.
   *
   * @param {object} ref - Receipt reference containing blockNumber and blockHash.
   * @returns {Promise<object>}
   */
  async block(ref) {
    integer(ref.blockNumber);
    check(hashShape(ref.blockHash), 'INVALID_BLOCK');
    check(BigInt(ref.blockNumber) <= BigInt(this.h.number), 'FUTURE_BLOCK');

    const b = await this.reader.rpc('eth_getBlockByNumber', [quantity(ref.blockNumber), false]);
    check(b?.hash === ref.blockHash, 'REORG');
    return b;
  }

  /**
   * Executes a read-only call against the RecordAnchor contract at this pinned block.
   *
   * @param {string} functionName
   * @param {Array<unknown>} [args=[]]
   * @returns {Promise<unknown>}
   */
  async call(functionName, args = []) {
    const data = encodeFunctionData({ abi: anchorAbi, functionName, args });
    const raw = await this.reader.rpc('eth_call', [
      { to: this.reader.trust.policy.anchorAddress, data },
      { blockHash: this.h.hash, requireCanonical: true }
    ]);
    return decodeFunctionResult({ abi: anchorAbi, functionName, data: raw });
  }

  /**
   * Returns the total count of batches anchored so far.
   *
   * @returns {Promise<string>}
   */
  async count() {
    return (await this.call('batchCount')).toString();
  }

  /**
   * Fetches metadata for an anchored batch by ID.
   *
   * @param {string|number|bigint} id - Batch ID.
   * @returns {Promise<{ batchId: string, root: string, count: number, blockNumber: string, blockHash: string, anchoredAt: string }>}
   */
  async batch(id) {
    integer(String(id), true);
    const key = String(id);

    if (!this.metas.has(key)) {
      const fetchTask = (async () => {
        const [root, count, number, time] = await this.call('batches', [BigInt(id)]);
        check(count > 0n && count <= 32n && number <= BigInt(this.h.number), 'BATCH_UNAVAILABLE');

        const block = await this.reader.rpc('eth_getBlockByNumber', [quantity(number), false]);
        check(block && BigInt(block.timestamp) === time, 'ANCHOR_MISMATCH');

        return {
          batchId: key,
          root,
          count: Number(count),
          blockNumber: number.toString(),
          blockHash: block.hash,
          anchoredAt: time.toString()
        };
      })();

      this.metas.set(key, fetchTask);
      fetchTask.catch(() => this.metas.delete(key));
    }

    return this.metas.get(key);
  }

  /**
   * Reads ERC20 token balance for the treasury at the reference block.
   *
   * @param {object} ref - Receipt reference.
   * @param {object} policy - Policy containing token and treasury.
   * @returns {Promise<string>} Balance as decimal string.
   */
  async balance(ref, policy) {
    await this.block(ref);
    const data = encodeFunctionData({ abi: tokenAbi, functionName: 'balanceOf', args: [policy.treasury] });
    const params = [{ to: policy.token, data }, { blockHash: ref.blockHash, requireCanonical: true }];
    const cacheKey = canonical({ chainId: policy.chainId, params });
    const reads = this.reader.reads;

    if (!reads.has(cacheKey)) {
      if (reads.size >= 256) {
        reads.delete(reads.keys().next().value);
      }
      const readTask = this.reader.rpc('eth_call', params).then(raw => {
        check(/^0x[0-9a-fA-F]{64}$/.test(raw), 'INVALID_STATE');
        return decodeFunctionResult({ abi: tokenAbi, functionName: 'balanceOf', data: raw }).toString();
      });
      reads.set(cacheKey, readTask);
      readTask.catch(() => {
        if (reads.get(cacheKey) === readTask) reads.delete(cacheKey);
      });
    }

    return reads.get(cacheKey);
  }

  /**
   * Reads credit state (collateral, debt) for a subject at the reference block.
   *
   * @param {object} ref - Receipt reference.
   * @param {string} subject - Borrower address.
   * @param {string} [contractAddress] - CreditState contract address.
   * @returns {Promise<{ collateral: string, debt: string }>}
   */
  async creditState(ref, subject, contractAddress) {
    await this.block(ref);
    const target = contractAddress ?? this.reader.trust.policy.creditStateAddress;
    const dataCollateral = encodeFunctionData({ abi: creditStateAbi, functionName: 'collateralOf', args: [subject] });
    const dataDebt = encodeFunctionData({ abi: creditStateAbi, functionName: 'debtOf', args: [subject] });

    const [rawCollateral, rawDebt] = await Promise.all([
      this.reader.rpc('eth_call', [{ to: target, data: dataCollateral }, { blockHash: ref.blockHash, requireCanonical: true }]),
      this.reader.rpc('eth_call', [{ to: target, data: dataDebt }, { blockHash: ref.blockHash, requireCanonical: true }])
    ]);

    check(
      /^0x[0-9a-fA-F]{64}$/.test(rawCollateral) && /^0x[0-9a-fA-F]{64}$/.test(rawDebt),
      'INVALID_STATE'
    );

    const collateral = decodeFunctionResult({ abi: creditStateAbi, functionName: 'collateralOf', data: rawCollateral }).toString();
    const debt = decodeFunctionResult({ abi: creditStateAbi, functionName: 'debtOf', data: rawDebt }).toString();

    return { collateral, debt };
  }
}

/**
 * Builds the transaction payload for anchoring a batch to RecordAnchor contract.
 *
 * @param {object} batch - { batchId, root, count }
 * @param {object} trust - Trust configuration.
 * @returns {{ chainId: string, to: string, value: string, data: string }}
 */
export function anchorCall(batch, trust) {
  check(
    hashShape(batch.root) &&
    Number.isInteger(batch.count) &&
    batch.count > 0 &&
    batch.count <= 32,
    'INVALID_BATCH'
  );
  integer(String(batch.batchId), true);

  return {
    chainId: trust.policy.chainId,
    to: trust.policy.anchorAddress,
    value: '0',
    data: encodeFunctionData({
      abi: anchorAbi,
      functionName: 'anchorBatch',
      args: [BigInt(batch.batchId), batch.root, BigInt(batch.count)]
    })
  };
}
