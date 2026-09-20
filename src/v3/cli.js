import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { check, parseWire } from '../common/crypto.js';
import { jsonRpc } from '../common/rpc.js';
import { ChainReader } from '../chain/reader.js';
import { Archive, EvidenceStore } from '../storage/store.js';
import { createEvidenceServer } from '../server/server.js';
import { auditAll, verifyOne } from '../verifier/verify.js';

async function main() {
  const [command, configFile, target, block] = process.argv.slice(2);
  check(['serve', 'verify', 'audit'].includes(command) && configFile, 'INVALID_ARGUMENTS');

  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const resolveConfigRelativePath = relPath => resolve(dirname(resolve(configFile)), relPath);
  const trust = JSON.parse(readFileSync(resolveConfigRelativePath(config.trustFile), 'utf8'));
  const reader = new ChainReader(jsonRpc(config.rpcUrl), trust);

  if (command === 'serve') {
    const store = new EvidenceStore(
      resolveConfigRelativePath(config.databaseFile),
      new Archive(resolveConfigRelativePath(config.archiveDirectory)),
      trust
    );

    const signer = config.signerKeyFile
      ? {
          keyId: config.signerKeyId,
          privateKey: readFileSync(resolveConfigRelativePath(config.signerKeyFile), 'utf8')
        }
      : undefined;

    const server = createEvidenceServer({
      store,
      reader,
      signer,
      writeToken: process.env.EVIDENCE_WRITE_TOKEN
    });

    const port = config.port ?? 4040;
    server.listen(port, '127.0.0.1', () => {
      console.log(`Evidence API listening on 127.0.0.1:${server.address().port}`);
    });

    const shutdown = () => {
      server.close(() => {
        store.close();
        process.exit(0);
      });
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  const pinnedBlock = block ?? config.asOf ?? 'finalized';
  const chain = await reader.at(pinnedBlock);

  const result = command === 'verify'
    ? await verifyOne(parseWire(readFileSync(target, 'utf8')), trust, chain)
    : await auditAll(new Archive(target ?? resolveConfigRelativePath(config.archiveDirectory)), trust, chain);

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  const message = /^[A-Z][A-Z_]+$/.test(err.message) ? err.message : 'OPERATION_FAILED';
  console.error(message);
  process.exitCode = 1;
});
