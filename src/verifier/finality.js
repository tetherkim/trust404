/**
 * Resolves the appropriate chain view for an audit:
 * Chooses a finalized view only when it includes the full latest log.
 * Otherwise retains the latest view with an explicit PROVISIONAL status.
 *
 * @param {import('../chain/reader.js').ChainReader} reader
 * @returns {Promise<import('../chain/reader.js').ChainView>}
 */
export async function auditView(reader) {
  const latestView = await reader.at('latest');
  const totalBatchCount = await latestView.count();
  const finalizedBlock = await reader.rpc('eth_getBlockByNumber', ['finalized', false]);

  if (BigInt(totalBatchCount) === 0n) {
    return latestView;
  }

  const latestBatch = await latestView.batch(String(totalBatchCount));
  if (BigInt(finalizedBlock.number) < BigInt(latestBatch.blockNumber)) {
    return latestView;
  }

  const finalizedView = await reader.at(finalizedBlock.hash);
  if (String(await finalizedView.count()) !== String(totalBatchCount)) {
    return latestView;
  }

  await latestView.assertCanonical();
  return finalizedView;
}
