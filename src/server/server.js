import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { canonical, parseWire, check } from '../common/crypto.js';
import { verifyOne } from '../verifier/verify.js';

/**
 * Creates the internal Evidence HTTP API server.
 * Handles authenticated request submission, batch preparation, decision evaluation,
 * and public evidence/verification queries.
 *
 * @param {object} options
 * @param {import('../storage/store.js').EvidenceStore} options.store
 * @param {import('../chain/reader.js').ChainReader} options.reader
 * @param {string} options.writeToken - Secret bearer token for mutations
 * @param {object} [options.signer] - { keyId, privateKey } for institution decisions
 * @param {object} [options.runtime] - Optional execution runtime adapter
 * @returns {import('node:http').Server}
 */
export function createEvidenceServer({ store, reader, writeToken, signer, runtime = null }) {
  check(typeof writeToken === 'string' && writeToken.length >= 32, 'WRITE_TOKEN_REQUIRED');
  const credential = Buffer.from(`Bearer ${writeToken}`);

  // Sequential queue for mutations: ensures batching and signing cannot race
  let mutationQueue = Promise.resolve();
  const queueMutation = taskFn => {
    const job = mutationQueue.then(taskFn);
    mutationQueue = job.catch(() => {});
    return job;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      let responseData;

      if (req.method === 'GET') {
        let match;
        if ((match = path.match(/^\/v3\/requests\/(0x[0-9a-f]{64})\/evidence$/))) {
          responseData = store.bundle(match[1]);
        } else if ((match = path.match(/^\/v3\/requests\/(0x[0-9a-f]{64})\/verification$/))) {
          const bundle = store.bundle(match[1]);
          const chainView = await reader.at('latest');
          responseData = await verifyOne(bundle, store.trust, chainView, runtime);
        } else if ((match = path.match(/^\/v3\/batches\/([1-9][0-9]*)$/))) {
          responseData = store.archive.batch(match[1]);
        } else if ((match = path.match(/^\/v3\/blobs\/(0x[0-9a-f]{64})$/))) {
          responseData = store.archive.blob(match[1]);
        } else {
          res.writeHead(404).end();
          return;
        }
      } else if (req.method === 'POST') {
        const authHeader = Buffer.from(req.headers.authorization ?? '');
        const isAuthorized =
          authHeader.length === credential.length &&
          timingSafeEqual(authHeader, credential);

        if (!isAuthorized) {
          res.writeHead(401).end();
          return;
        }

        let totalSize = 0;
        const chunks = [];
        for await (const chunk of req) {
          totalSize += chunk.length;
          check(totalSize <= 1024 * 1024, 'BODY_TOO_LARGE');
          chunks.push(chunk);
        }

        const body = parseWire(Buffer.concat(chunks).toString('utf8'));

        responseData = await queueMutation(async () => {
          if (path === '/v3/requests') {
            return store.submit(body);
          }
          if (path === '/v3/batches/prepare') {
            return store.prepare(await reader.at('latest'));
          }
          const evalMatch = path.match(/^\/v3\/requests\/(0x[0-9a-f]{64})\/evaluate$/);
          if (evalMatch) {
            check(signer, 'SIGNER_UNAVAILABLE');
            return store.decide(evalMatch[1], await reader.at('latest'), signer.keyId, signer.privateKey);
          }
          throw new Error('NOT_FOUND');
        });
      } else {
        res.writeHead(405).end();
        return;
      }

      res
        .writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        })
        .end(canonical(responseData));
    } catch (err) {
      const isKnownCode = /^[A-Z][A-Z_]+$/.test(err.message);
      const errorCode = isKnownCode ? err.message : 'DATA_UNAVAILABLE';
      const statusCode = errorCode === 'BODY_TOO_LARGE' ? 413 : 400;

      res
        .writeHead(statusCode, { 'content-type': 'application/json' })
        .end(canonical({ error: errorCode }));
    }
  });
}
