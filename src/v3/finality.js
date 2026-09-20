// Choose a finalized view only when it includes the full latest log.
// Otherwise retain the latest view and its explicit PROVISIONAL status.
export async function auditView(reader) {
  const latest = await reader.at('latest');
  const count = await latest.count();
  const finalizedBlock = await reader.rpc('eth_getBlockByNumber', ['finalized', false]);
  if (BigInt(count) === 0n) return latest;
  const tail = await latest.batch(String(count));
  if (BigInt(finalizedBlock.number) < BigInt(tail.blockNumber)) return latest;
  const finalized = await reader.at(finalizedBlock.hash);
  if (String(await finalized.count()) !== String(count)) return latest;
  await latest.assertCanonical();
  return finalized;
}
