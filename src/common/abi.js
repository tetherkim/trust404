import { parseAbi } from 'viem';

/**
 * ABI for the on-chain RecordAnchor contract.
 * Anchors periodic Merkle roots of off-chain decision and request batches.
 */
export const anchorAbi = parseAbi([
  'function publisher() view returns (address)',
  'function batchCount() view returns (uint256)',
  'function batches(uint256) view returns (bytes32 root, uint256 count, uint256 blockNumber, uint256 anchoredAt)',
  'function anchorBatch(uint256 expectedBatchId, bytes32 root, uint256 count)',
]);

/**
 * Minimal ABI for standard ERC20 balanceOf reads.
 */
export const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);

/**
 * ABI for CreditState contract tracking borrower collateral and debt.
 */
export const creditStateAbi = parseAbi([
  'function owner() view returns (address)',
  'function collateralOf(address) view returns (uint256)',
  'function debtOf(address) view returns (uint256)',
  'function setAccountState(address user, uint256 collateral, uint256 debt)',
]);
