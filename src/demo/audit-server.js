import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { auditFile, readUpload } from './audit-file.js';
import { check } from '../v3/crypto.js';

export async function startAuditServer(profileFile, port = 4040) {
  const file = resolve(profileFile), profiles = new Map();
  for (const config of JSON.parse(readFileSync(file, 'utf8'))) {
    const trust = JSON.parse(readFileSync(resolve(dirname(file), config.trustFile), 'utf8'));
    check(!profiles.has(trust.policyHash), 'DUPLICATE_TRUST_PROFILE');
    profiles.set(trust.policyHash, { trust, rpcUrl: config.rpcUrl, asOf: config.asOf ?? 'auto' });
  }
  const server = createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
    try {
      check(req.headers.host === `127.0.0.1:${server.address().port}`, 'LOCAL_HOST_REQUIRED');
      check(!req.headers.origin || req.headers.origin === `http://${req.headers.host}`, 'LOCAL_ORIGIN_REQUIRED');
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'POST' && path === '/api/audit-file') {
        check(req.headers['content-type']?.split(';')[0] === 'application/json', 'JSON_REQUIRED');
        const result = await auditFile(await readUpload(req), profiles);
        res.writeHead(200, {...headers, 'content-type': 'application/json'}).end(JSON.stringify(result)); return;
      }
      if (req.method !== 'GET') { res.writeHead(405, headers).end(); return; }
      if (path === '/' || path === '/ui.js') {
        res.writeHead(200, {...headers, 'content-type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'})
          .end(readFileSync(new URL(path === '/' ? './index.html' : './ui.js', import.meta.url))); return;
      }
      let result;
      if (path === '/api/profiles') result = [...profiles].map(([id, {trust, asOf}]) => ({id, institutionId:trust.policy.institutionId, policyId:trust.policy.policyId, chainId:trust.policy.chainId, anchorAddress:trust.policy.anchorAddress, cutoff:asOf}));
      else if (path === '/api/samples') result = [];
      else { res.writeHead(404, headers).end(); return; }
      res.writeHead(200, {...headers, 'content-type':'application/json'}).end(JSON.stringify(result));
    } catch (error) {
      const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'AUDIT_UNAVAILABLE';
      res.writeHead(code.startsWith('LOCAL_') ? 403 : 400, {...headers, 'content-type':'application/json'}).end(JSON.stringify({error:code}));
    }
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('Usage: npm run audit:serve -- <profiles.json> [port]'); process.exitCode=1; }
  else {
    const server = await startAuditServer(process.argv[2], Number(process.argv[3] ?? 4040));
    console.log(`감사 파일 가져오기: http://127.0.0.1:${server.address().port}`);
  }
}
