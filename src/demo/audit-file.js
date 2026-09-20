import { auditView } from '../v3/finality.js';
import { check, canonical } from '../v3/crypto.js';
import { auditAll } from '../v3/verify.js';
import { ChainReader, jsonRpc } from '../v3/chain.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export async function readUpload(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    check(bytes <= MAX_FILE_BYTES, 'FILE_TOO_LARGE'); chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_JSON'); }
  canonical(value);
  return value;
}
export async function auditFile(input, profiles) {
  check(input?.format === 'trust404-audit-v1', 'INVALID_FILE_FORMAT');
  const profile = profiles.get(input.profileId);
  check(profile, 'UNKNOWN_TRUST_PROFILE');
  check(input.batches && typeof input.batches === 'object' && !Array.isArray(input.batches), 'INVALID_BATCHES');
  check(input.blobs && typeof input.blobs === 'object' && !Array.isArray(input.blobs), 'INVALID_BLOBS');
  check(Object.keys(input.batches).length <= 1000 && Object.keys(input.blobs).length <= 10000, 'FILE_TOO_LARGE');
  // Neither endpoint, trust keys, nor the audit cutoff can be supplied by the file.
  const reader = new ChainReader(jsonRpc(profile.rpcUrl), profile.trust);
  const chain = profile.asOf === 'auto' ? await auditView(reader) : await reader.at(profile.asOf ?? 'finalized');
  check(BigInt(await chain.count()) <= 1000n, 'AUDIT_LIMIT_EXCEEDED');
  const archive = {
    batch(id) { check(Object.hasOwn(input.batches, id), 'DATA_UNAVAILABLE'); return input.batches[id]; },
    blob(id) { check(Object.hasOwn(input.blobs, id), 'DATA_UNAVAILABLE'); return input.blobs[id]; },
  };
  const result = await auditAll(archive, profile.trust, chain);
  return { ...result, profileId: input.profileId, chainId: profile.trust.policy.chainId,
    anchorAddress: profile.trust.policy.anchorAddress, policyHash: profile.trust.policyHash };
}
