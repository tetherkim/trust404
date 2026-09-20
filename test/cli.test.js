import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildBundle, createInstitution, createRequest, decodePayload, encodePayload, hash, sign
} from '../src/evidence.js';
import { createTestWitness, disk, entryView, alterPayload, fixture, json, POLICY } from './helpers.js';

const cli = new URL('../src/cli.js', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', timeout: 5000, env: { ...process.env, RPC_URL: '' },
});

test('R7,R8: saved evidence verifies offline without institution files', async t => {
  const { institution, receipt, verificationContext, bundle, entries } = await fixture();
  const directory = mkdtempSync(join(tmpdir(), 'trust404-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'institution'));
  const file = join(directory, 'evidence.json');
  const verificationContextFile = join(directory, 'verification-context.json');
  writeFileSync(verificationContextFile, json(verificationContext));
  writeFileSync(file, json(bundle));
  assert.equal(run('verify', file, verificationContextFile).status, 0);
  rmSync(join(directory, 'institution'), { recursive: true });
  const result = run('verify', file, verificationContextFile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'LIMIT_EXCEEDED');
  const receiptVerificationContext = await institution.getVerificationContext(receipt.checkpointId);
  writeFileSync(verificationContextFile, json(receiptVerificationContext));
  writeFileSync(file, json(receipt));
  assert.equal(run('receipt', file, verificationContextFile).status, 0);
  assert.equal(run('verify', file, verificationContextFile).status, 1);
  writeFileSync(verificationContextFile, json(verificationContext));
  writeFileSync(file, json(entries));
  assert.equal(run('audit', file, verificationContextFile).status, 0);
});

test('R8: CLI distinguishes tampering, incomplete audit and deadline outcomes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'trust404-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'evidence.json');
  const verificationContextFile = join(directory, 'verification-context.json');
  const { verificationContext, bundle, entries } = await fixture();
  function check(command, value, selectedContext = verificationContext) {
    writeFileSync(file, json(value)); writeFileSync(verificationContextFile, json(selectedContext));
    return run(command, file, verificationContextFile);
  }
  const tampered = structuredClone(bundle); alterPayload(tampered.decision.entry, e => e.payload.reason = 'OTHER');
  assert.equal(check('verify', tampered).status, 1);
  assert.equal(check('audit', entries.slice(1)).status, 1);
  const incomplete = structuredClone(entries); incomplete[1].payloadBytes = null;
  const missing = check('audit', incomplete);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error, 'MISSING_PAYLOAD');
  const logClient = createTestWitness();
  const customerKeys = generateKeyPairSync('ed25519');
  const institutionKeys = generateKeyPairSync('ed25519');
  const pending = createInstitution({
    logClient, policy: POLICY, institutionKeys,
    customerKey: customerKeys.publicKey.export({ type: 'spki', format: 'pem' })
  });
  const request = createRequest({
    id: 'unanswered', amount: 1, policy: POLICY, customerPrivateKey: customerKeys.privateKey
  });
  const pendingReceipt = await pending.accept(request);
  for (const [time, code, field] of [[1059, 0, 'pending'], [1060, 1, 'overdue']]) {
    logClient.time = time;
    const selectedCheckpoint = await logClient.createCheckpoint();
    const selectedContext = await pending.getVerificationContext(selectedCheckpoint.checkpointId);
    const output = check('audit', await pending.exportLog(selectedContext.checkpointId), selectedContext);
    assert.equal(output.status, code, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout)[field], ['unanswered']);
  }
  logClient.time = 1061;
  const decision = await pending.decide(pendingReceipt);
  const decisionVerificationContext = await pending.getVerificationContext(decision.checkpointId);
  const late = check('verify', decision, decisionVerificationContext);
  assert.equal(late.status, 0);
  assert.equal(JSON.parse(late.stdout).outcome, 'APPROVED');
});

test('CLI rejects correctly signed and registered decisions that contradict policy', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'trust404-wrong-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'evidence.json');
  const verificationContextFile = join(directory, 'verification-context.json');

  for (const [amount, outcome, reason] of [
    [1500000, 'APPROVED', 'WITHIN_LIMIT'],
    [500000, 'REJECTED', 'LIMIT_EXCEEDED'],
    [1500000, 'REJECTED', 'WITHIN_LIMIT'],
  ]) {
    const logClient = createTestWitness();
    const customerKeys = generateKeyPairSync('ed25519');
    const institutionKeys = generateKeyPairSync('ed25519');
    const institution = createInstitution({
      logClient, policy: POLICY, institutionKeys,
      customerKey: customerKeys.publicKey.export({ type: 'spki', format: 'pem' })
    });
    const receipt = await institution.accept(createRequest({
      id: 'wrong-policy', amount, policy: POLICY, customerPrivateKey: customerKeys.privateKey
    }));
    const request = receipt.request.entry;
    const envelope = sign('decision', {
      version: 1,
      requestHash: hash(decodePayload(request.payloadBytes, request.record)),
      policyHash: hash(POLICY),
      outcome,
      reason,
    }, institutionKeys.privateKey);
    const bytes = encodePayload(envelope);
    const decision = entryView(await logClient.registerDecision(request.record.index, bytes), bytes);
    const verificationContext = await institution.getVerificationContext(decision.checkpointId);
    const entries = [...await institution.exportLog(receipt.checkpointId), decision];
    writeFileSync(verificationContextFile, json(verificationContext));

    writeFileSync(file, json(buildBundle(entries, request, undefined, verificationContext)));
    const receiptResult = run('receipt', file, verificationContextFile);
    assert.equal(receiptResult.status, 0, receiptResult.stderr);

    for (const [command, evidence] of [
      ['verify', buildBundle(entries, request, decision, verificationContext)],
      ['audit', entries],
    ]) {
      writeFileSync(file, json(evidence));
      const result = run(command, file, verificationContextFile);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).error, 'POLICY_MISMATCH');
    }
  }
});

test('CLI validates policy when loading an external verification context for each command', async t => {
  const { receipt, verificationContext, bundle, entries, institution } = await fixture();
  const receiptVerificationContext = await institution.getVerificationContext(receipt.checkpointId);
  const directory = mkdtempSync(join(tmpdir(), 'trust404-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'evidence.json');
  const verificationContextFile = join(directory, 'verification-context.json');
  for (const [command, evidence] of [
    ['receipt', receipt],
    ['verify', bundle],
    ['audit', entries],
  ]) {
    writeFileSync(file, json(evidence));
    const selectedContext = command === 'receipt' ? receiptVerificationContext : verificationContext;
    writeFileSync(verificationContextFile, json({ ...selectedContext, policy: { ...selectedContext.policy, limit: 500000 } }));
    const result = run(command, file, verificationContextFile);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'UNSUPPORTED_POLICY');
    writeFileSync(verificationContextFile, json(selectedContext));
    assert.equal(run(command, file, verificationContextFile).status, 0);
  }
});

test('demo emits overdue and policy-violating evidence and keeps normal evidence verifiable offline', t => {
  const directory = mkdtempSync(join(tmpdir(), 'trust404-demo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const out = join(directory, 'output');
  const lifecycle = join(directory, 'lifecycle.log');
  const mockWitness = `
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    import { createTestWitness } from ${JSON.stringify(new URL('./helpers.js', import.meta.url).href)};
    const base = createTestWitness();
    let witnessClosed = false;
    let auditorClosed = false;
    const open = (role, fn) => (...args) => {
      assert.equal(role === 'witness' ? witnessClosed : auditorClosed, false, role + '_CLOSED');
      return fn(...args);
    };
    const logClient = {
      context: base.context,
      registerRequest: open('witness', (...args) => base.registerRequest(...args)),
      registerDecision: open('witness', (...args) => base.registerDecision(...args)),
      readRecord: open('witness', (...args) => base.readRecord(...args)),
      readCheckpoint: open('witness', (...args) => base.readCheckpoint(...args)),
      createCheckpoint: open('witness', (...args) => base.createCheckpoint(...args)),
      close() {
        assert.equal(witnessClosed, false, 'WITNESS_CLOSED_TWICE');
        witnessClosed = true;
        appendFileSync(${JSON.stringify(lifecycle)}, 'witness-close\\n');
      },
    };
    export async function deployEvmWitness() {
      return logClient;
    }
    export async function evidenceLogArtifact() { return { abi: [] }; }
    export class Contract {
      constructor(address, abi, provider) {
        assert.equal(address, base.context.evidenceLogAddress);
        assert(provider instanceof JsonRpcProvider);
        provider.role = 'auditor';
      }
    }
    export async function checkEvmContext(contract, context) {
      assert(contract instanceof Contract);
      assert.deepEqual(context, base.context);
      if (process.env.FAIL_CONTEXT_CHECK) throw new Error('CHAIN_MISMATCH');
      return structuredClone(context);
    }
    export const readCheckpoint = open('auditor', (contract, id) => {
      assert(contract instanceof Contract);
      return id === undefined ? base.readLatestCheckpoint() : base.readCheckpoint(id);
    });
    export class JsonRpcProvider {
      role = 'clock';
      async send(method, params) {
        assert.equal(method, 'evm_increaseTime');
        assert.deepEqual(params, [60]);
        base.time += params[0];
      }
      destroy() {
        if (this.role === 'auditor') {
          assert.equal(auditorClosed, false, 'AUDITOR_CLOSED_TWICE');
          auditorClosed = true;
        }
        appendFileSync(${JSON.stringify(lifecycle)}, this.role + '-close\\n');
      }
    }
  `;
  const mockUrl = `data:text/javascript,${encodeURIComponent(mockWitness)}`;
  const hooks = `
    export function resolve(specifier, context, nextResolve) {
      if (['./evm.js', 'ethers'].includes(specifier) && context.parentURL === ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)}) {
        return { url: ${JSON.stringify(mockUrl)}, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `;
  const preload = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
  const demo = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`, cli, 'demo', out,
  ], { encoding: 'utf8', timeout: 5000, env: { ...process.env, RPC_URL: 'offline-test' } });
  assert.equal(demo.status, 0, demo.stderr);
  assert.deepEqual(readFileSync(lifecycle, 'utf8').trim().split('\n'), [
    'clock-close', 'auditor-close', 'witness-close'
  ]);
  const checks = JSON.parse(demo.stdout).checks;
  assert.equal(checks.length, 8);
  assert.deepEqual(checks.slice(-2), [
    { name: '접수 후 판단 누락', result: 'DETECTED' },
    { name: '정책 위반 판단', result: 'DETECTED' },
  ]);

  const normalVerificationContext = JSON.parse(readFileSync(join(out, 'auditor/verification-context.json'), 'utf8'));
  const rejectionVerificationContext = JSON.parse(readFileSync(join(out, 'customer/rejection-verification-context.json'), 'utf8'));
  const approvalVerificationContext = JSON.parse(readFileSync(join(out, 'customer/approval-verification-context.json'), 'utf8'));
  const auditSubmission = JSON.parse(readFileSync(join(out, 'auditor/submission.json'), 'utf8'));
  const institutionLog = JSON.parse(readFileSync(join(out, 'institution/full-log.json'), 'utf8'));
  const missingVerificationContext = JSON.parse(readFileSync(join(out, 'attacks/missing-verification-context.json'), 'utf8'));
  const missingLog = JSON.parse(readFileSync(join(out, 'attacks/missing-log.json'), 'utf8'));
  for (const entry of missingLog) {
    assert.deepEqual(Object.keys(entry).sort(), ['checkpointId', 'payloadBytes', 'record']);
  }
  const wrongPolicyVerificationContext = JSON.parse(readFileSync(join(out, 'attacks/wrong-policy-verification-context.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(join(out, 'customer/receipt.json'), 'utf8'));
  const receiptVerificationContext = JSON.parse(readFileSync(join(out, 'customer/receipt-verification-context.json'), 'utf8'));
  const rejection = JSON.parse(readFileSync(join(out, 'customer/rejection.json'), 'utf8'));
  const approval = JSON.parse(readFileSync(join(out, 'customer/approval.json'), 'utf8'));
  assert.deepEqual(receipt, disk(buildBundle(institutionLog.slice(0, 1), institutionLog[0], undefined, receiptVerificationContext)));
  assert.deepEqual(rejection, disk(buildBundle(institutionLog.slice(0, 2), institutionLog[0], institutionLog[1], rejectionVerificationContext)));
  assert.deepEqual(approval, disk(buildBundle(institutionLog.slice(0, 4), institutionLog[2], institutionLog[3], approvalVerificationContext)));
  assert.deepEqual(wrongPolicyVerificationContext.policy, normalVerificationContext.policy);
  assert.equal(rejectionVerificationContext.checkpoint.size, '2');
  assert.equal(approvalVerificationContext.checkpoint.size, '4');
  assert.equal(normalVerificationContext.checkpoint.size, '4');
  assert.equal(auditSubmission.length, 4);
  assert.equal(institutionLog.length, 6);
  assert.equal(existsSync(join(out, 'witness/log.json')), false);
  assert.equal(missingVerificationContext.checkpoint.size, '5');
  assert.equal(wrongPolicyVerificationContext.checkpoint.size, '7');
  const unanswered = missingLog.at(-1);
  assert.equal(unanswered.record.kind, '0');
  assert.equal(decodePayload(unanswered.payloadBytes, unanswered.record).payload.id, 'unanswered');
  assert.equal(BigInt(missingVerificationContext.checkpoint.issuedAt) - BigInt(unanswered.record.recordedAt), 60n);

  const missing = run('audit', join(out, 'attacks/missing-log.json'), join(out, 'attacks/missing-verification-context.json'));
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, '');
  assert.deepEqual(JSON.parse(missing.stdout), {
    ok: false, requests: 3, decisions: 2, pending: [], overdue: ['unanswered'],
  });

  for (const [command, file, verificationContextFile, error] of [
    ['receipt', 'customer/receipt.json', 'customer/receipt-verification-context.json'],
    ['verify', 'customer/rejection.json', 'customer/rejection-verification-context.json'],
    ['verify', 'customer/approval.json', 'customer/approval-verification-context.json'],
    ['audit', 'auditor/submission.json', 'auditor/verification-context.json'],
    ['verify', 'attacks/tampered.json', 'customer/rejection-verification-context.json', 'PAYLOAD_HASH_MISMATCH'],
    ['verify', 'attacks/forged-signature.json', 'customer/rejection-verification-context.json', 'PAYLOAD_HASH_MISMATCH'],
    ['audit', 'attacks/deleted-log.json', 'auditor/verification-context.json', 'LOG_SIZE_MISMATCH'],
    ['verify', 'attacks/wrong-policy-result.json', 'attacks/wrong-policy-verification-context.json', 'POLICY_MISMATCH'],
  ]) {
    assert.equal(readFileSync(join(out, file), 'utf8').includes('"txHash"'), false, file);
    const result = run(command, join(out, file), join(out, verificationContextFile));
    assert.equal(result.status, error ? 1 : 0, result.stderr);
    if (error) assert.equal(JSON.parse(result.stderr).error, error);
    else assert.equal(JSON.parse(result.stdout).ok, true);
  }

  const failed = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`, cli, 'demo', join(directory, 'failed'),
  ], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, RPC_URL: 'offline-test', FAIL_CONTEXT_CHECK: '1' },
  });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stderr).error, 'CHAIN_MISMATCH');
  assert.deepEqual(readFileSync(lifecycle, 'utf8').trim().split('\n'), [
    'clock-close', 'auditor-close', 'witness-close', 'auditor-close', 'witness-close'
  ]);
});

test('CLI rejects invalid arguments and demo requires explicit RPC configuration', async t => {
  assert.equal(run('unknown').status, 1);
  assert.equal(run('verify').status, 1);
  assert.equal(run('audit', 'absent.json', 'absent-verification-context.json').status, 1);
  assert.equal(run('verify', 'a', 'b', 'extra').status, 1);
  const withoutRpc = run('demo');
  assert.equal(withoutRpc.status, 1);
  assert.equal(JSON.parse(withoutRpc.stderr).error, 'RPC_URL_REQUIRED');
  const directory = mkdtempSync(join(tmpdir(), 'trust404-existing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const existing = spawnSync(process.execPath, [cli, 'demo', directory], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, RPC_URL: 'http://127.0.0.1:1' },
  });
  assert.equal(existing.status, 1);
  assert.match(JSON.parse(existing.stderr).error, /EEXIST/);
});
