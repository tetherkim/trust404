import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { startDemo } from '../../src/demo/local.js';

test('[로컬 시연] 실제 레코드 생성 및 5가지 시나리오(정상 거절, 변조, 유실, 미등록, 불일치) 독립 탐지 검증', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'trust404-demo-test-'));
  const demo = await startDemo({ port: 0, directory, deploymentPublisher: '0xcfFb0eEd0e42876470Af1451BC3d4e3F865bB987' });
  t.after(async () => { await demo.close(); rmSync(directory, { recursive: true, force: true }); });
  const status = await (await fetch(`${demo.url}/api/status`)).json();
  assert.equal(status.aomiConnected, false); assert.equal(status.chainId, 31337); assert.equal(status.scenarios.length, 5);
  const results = {};
  for (const scenario of status.scenarios) {
    assert.match(scenario.requestAnchor.root, /^0x[0-9a-f]{64}$/);
    assert(BigInt(scenario.requestAnchor.blockNumber) < BigInt(scenario.asOf.blockNumber));
    assert.equal(scenario.decisionWindowSeconds, 90);
    assert.equal(scenario.decisionAnchor === null, scenario.id === 'missing');
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
  const profiles = await (await fetch(`${demo.url}/api/profiles`)).json();
  assert.equal(profiles.length, 5);
  const deployment = await (await fetch(`${demo.url}/api/deployment`)).json();
  assert.equal(deployment.chainId, 84532);
  assert.equal(deployment.publisher, '0xcffb0eed0e42876470af1451bc3d4e3f865bb987');
  assert.equal(deployment.transaction.from, deployment.publisher);
  assert.equal(deployment.transaction.value, '0x0');
  assert.equal(Object.hasOwn(deployment.transaction, 'to'), false);
  assert.match(deployment.transaction.data, /^0x[0-9a-f]+$/);
  const upload = file => fetch(`${demo.url}/api/audit-file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file) });
  for (const scenario of status.scenarios) {
    const file = await (await fetch(`${demo.url}/api/sample/${scenario.id}`)).json();
    const response = await upload(file); assert.equal(response.status, 200);
    const audited = await response.json();
    assert.deepEqual(audited.requests, results[scenario.id].requests);
    assert.deepEqual(audited.issues, results[scenario.id].issues);
    assert.equal(audited.complete, results[scenario.id].complete);
  }
  const file = await (await fetch(`${demo.url}/api/sample/rejection`)).json();
  const changed = structuredClone(file); changed.batches['2'][0].decision.payload.outcome = 'APPROVED';
  assert((await (await upload(changed)).json()).issues.some(i => i.code === 'TAMPERED_EXPORT'));
  const deleted = structuredClone(file); delete deleted.batches['2'];
  const deletionResult = await (await upload(deleted)).json();
  assert.equal(deletionResult.complete, false); assert.equal(deletionResult.requests[0].timing, 'UNKNOWN');
  const injected = { ...file, rpcUrl: 'http://untrusted.invalid', asOf: '0x0', trust: {} };
  assert.equal((await (await upload(injected)).json()).ok, true);
  assert.equal((await (await upload({ ...file, profileId: 'untrusted' })).json()).error, 'UNKNOWN_TRUST_PROFILE');
  const oversize = await fetch(`${demo.url}/api/audit-file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(2 * 1024 * 1024 + 1) });
  assert.equal((await oversize.json()).error, 'FILE_TOO_LARGE');
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
