import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Fixed, read-only connectivity probe. No wallet, staging or signing operation.
const localCli = fileURLToPath(new URL('../.git/aomi-tools/node_modules/.bin/aomi', import.meta.url));
const cli = process.env.AOMI_CLI || (existsSync(localCli) ? localCli : 'aomi');
const block = 47034297;
try {
  const { stdout } = await promisify(execFile)(cli, ['pipeline', 'invoke', 'encode_and_call', '--app', 'default', '--arguments', JSON.stringify({
    chain_id: 84532, to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    function_signature: 'balanceOf(address)', arguments: ['0x0000000000000000000000000000000000000000'],
    from: '0x0000000000000000000000000000000000000000', block_tag: String(block), topic: 'TRUST404 historical read verification',
  })], { timeout: 60000, maxBuffer: 1024 * 1024 });
  const envelope = JSON.parse(stdout), result = typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result;
  if (!result?.success || Number(result.served_block) !== block || result.tx?.chain_id !== 84532 || !/^0x[0-9a-fA-F]{64}$/.test(result.result)) throw new Error('UNVERIFIED_RESPONSE');
  console.log(JSON.stringify({ status: 'READ_VERIFIED', chainId: 84532, servedBlock: result.served_block,
    balanceRaw: BigInt(result.result).toString(), checkedAt: new Date().toISOString(), signingTested: false, auditRuntime: 'local-rpc' }, null, 2));
} catch (error) {
  // Do not forward CLI output, which may contain device-flow or credential data.
  console.error(error.code === 'ENOENT' ? 'AOMI_CLI_NOT_FOUND' : 'AOMI_READ_NOT_VERIFIED: check CLI authentication and retry.');
  process.exitCode = 1;
}
