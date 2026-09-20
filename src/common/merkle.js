import { canonical, sha, check, hashShape } from './crypto.js';

/**
 * Computes leaf hash according to RFC 6962: SHA-256(0x00 || canonical(value)).
 *
 * @param {unknown} value - Value to hash as a leaf.
 * @returns {string} 0x-prefixed SHA-256 hex string.
 */
const computeLeafHash = value =>
  sha(Buffer.concat([Buffer.from([0]), Buffer.from(canonical(value))]));

/**
 * Computes branch hash according to RFC 6962: SHA-256(0x01 || leftHash || rightHash).
 *
 * @param {string} leftHex - 0x-prefixed hex string of left child.
 * @param {string} rightHex - 0x-prefixed hex string of right child.
 * @returns {string} 0x-prefixed SHA-256 hex string.
 */
const computeBranchHash = (leftHex, rightHex) =>
  sha(Buffer.concat([
    Buffer.from([1]),
    Buffer.from(leftHex.slice(2), 'hex'),
    Buffer.from(rightHex.slice(2), 'hex')
  ]));

/**
 * Computes largest power of 2 strictly less than n (for balanced binary tree split).
 *
 * @param {number} n - Number of items (> 1).
 * @returns {number} Power of 2.
 */
const largestPowerOfTwoLessThan = n => 2 ** Math.floor(Math.log2(n - 1));

/**
 * Constructs an RFC 6962 Merkle tree over an array of records (1 to 32 items).
 *
 * @param {Array<unknown>} records - Array of records to anchor.
 * @returns {{ root: string, count: number, proof: (index: number) => Array<{ side: 'left'|'right', hash: string }> }}
 */
export function buildTree(records) {
  check(
    Array.isArray(records) && records.length > 0 && records.length <= 32,
    'INVALID_BATCH_SIZE'
  );

  // Freeze records into canonical representation to ensure deterministic leaf hashing
  const frozenRecords = JSON.parse(canonical(records));

  function buildSubtree(startIndex, size) {
    if (size === 1) {
      return {
        hash: computeLeafHash(frozenRecords[startIndex]),
        start: startIndex,
        size
      };
    }

    const splitPoint = largestPowerOfTwoLessThan(size);
    const leftChild = buildSubtree(startIndex, splitPoint);
    const rightChild = buildSubtree(startIndex + splitPoint, size - splitPoint);

    return {
      hash: computeBranchHash(leftChild.hash, rightChild.hash),
      start: startIndex,
      size,
      left: leftChild,
      right: rightChild
    };
  }

  const rootNode = buildSubtree(0, frozenRecords.length);

  return {
    root: rootNode.hash,
    count: frozenRecords.length,
    /**
     * Generates the Merkle audit path for the leaf at `index`.
     *
     * @param {number} index - 0-based leaf index.
     * @returns {Array<{ side: 'left'|'right', hash: string }>}
     */
    proof(index) {
      check(
        Number.isInteger(index) && index >= 0 && index < frozenRecords.length,
        'INVALID_INDEX'
      );

      function traverse(node) {
        if (node.size === 1) {
          return [];
        }
        if (index < node.right.start) {
          return [...traverse(node.left), { side: 'right', hash: node.right.hash }];
        } else {
          return [...traverse(node.right), { side: 'left', hash: node.left.hash }];
        }
      }

      return traverse(rootNode);
    }
  };
}

/**
 * Verifies that a record is included in the Merkle tree with root `expectedRoot`.
 * Throws an Error('INVALID_INCLUSION') if verification fails.
 *
 * @param {unknown} record - The record to verify.
 * @param {number} index - The 0-based index of the leaf.
 * @param {number} count - Total leaf count in the batch.
 * @param {Array<{ side: 'left'|'right', hash: string }>} proof - Audit path.
 * @param {string} expectedRoot - Expected Merkle root hash.
 */
export function verifyProof(record, index, count, proof, expectedRoot) {
  const isCountValid = Number.isInteger(count) && count > 0 && count <= 32;
  const isIndexValid = Number.isInteger(index) && index >= 0 && index < count;
  check(isCountValid && isIndexValid, 'INVALID_INCLUSION');
  check(Array.isArray(proof) && hashShape(expectedRoot), 'INVALID_INCLUSION');

  function calculateExpectedDirections(leafIndex, totalCount) {
    if (totalCount === 1) {
      return [];
    }
    const splitPoint = largestPowerOfTwoLessThan(totalCount);
    if (leafIndex < splitPoint) {
      return [...calculateExpectedDirections(leafIndex, splitPoint), 'right'];
    } else {
      return [...calculateExpectedDirections(leafIndex - splitPoint, totalCount - splitPoint), 'left'];
    }
  }

  const expectedDirections = calculateExpectedDirections(index, count);
  check(proof.length === expectedDirections.length, 'INVALID_INCLUSION');

  let currentHash = computeLeafHash(record);
  for (let i = 0; i < proof.length; i++) {
    const step = proof[i];
    check(
      step && step.side === expectedDirections[i] && hashShape(step.hash),
      'INVALID_INCLUSION'
    );

    currentHash = step.side === 'left'
      ? computeBranchHash(step.hash, currentHash)
      : computeBranchHash(currentHash, step.hash);
  }

  check(currentHash === expectedRoot, 'INVALID_INCLUSION');
}
