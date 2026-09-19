import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { startDemo } from '../../src/demo/local.js';

test('local demo creates real records and independently detects all five scenarios', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'trust404-demo-test-'));
  const demo = await startDemo({ port: 0, directory });
  t.after(async () => { await demo.close(); rmSync(directory, { recursive: true, force: true }); });
  const status = await (await fetch(`${demo.url}/api/status`)).json();
  assert.equal(status.aomiConnected, false); assert.equal(status.chainId, 31337); assert.equal(status.scenarios.length, 5);
  const results = {};
  for (const scenario of status.scenarios) {
    const response = await fetch(`${demo.url}/api/audit/${scenario.id}`); assert.equal(response.status, 200);
    results[scenario.id] = await response.json(); assert.equal(results[scenario.id].asOf.blockHash, scenario.asOf.blockHash);
  }
  assert.equal(results.rejection.ok, true);
  assert.equal(results.rejection.requests[0].decisions[0].reason, 'RESERVE_FLOOR');
  assert(results.tamper.issues.some(i => i.code === 'TAMPERED_EXPORT'));
  assert.equal(results.unavailable.complete, false);
  assert.equal(results.unavailable.requests[0].timing, 'UNKNOWN');
  assert.equal(results.missing.complete, true);
  assert.equal(results.missing.requests[0].timing, 'MISSING_AS_OF_H');
  assert(results.wrong.issues.some(i => i.code === 'POLICY_MISMATCH'));
  assert.equal((await fetch(`${demo.url}/api/status`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    get(`${demo.url}/api/status`, { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${demo.url}/api/audit/rejection`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${demo.url}/`)).status, 200);
});
