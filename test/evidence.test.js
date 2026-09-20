import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  audit,
  canonical,
  createInstitution,
  createRequest,
  decodePayload,
  encodePayload,
  hash,
  sign,
  verifyReceipt,
  verifySingle,
} from '../src/evidence.js';
import { buildTree } from '../src/evm.js';
import { createTestWitness, disk, fixture, POLICY } from './helpers.js';

function setup(options = {}) {
  const logClient = options.logClient ?? createTestWitness();
  const customerKeys = options.customerKeys ?? generateKeyPairSync('ed25519');
  const institutionKeys = options.institutionKeys ?? generateKeyPairSync('ed25519');
  const customerKey = customerKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const institution = createInstitution({
    logClient,
    policy: POLICY,
    institutionKeys,
    customerKey,
    ...options.callbacks,
  });
  const request = (id, amount) => createRequest({
    id, amount, policy: POLICY, customerPrivateKey: customerKeys.privateKey,
  });
  return { logClient, customerKeys, institutionKeys, customerKey, institution, request };
}

test('canonical bytes, hashes and Ed25519 signatures remain stable', () => {
  const value = { z: 1, a: ['한글', true] };
  assert.equal(canonical(value), '{"a":["한글",true],"z":1}');
  assert.equal(hash(value), createHash('sha256').update('{"a":["한글",true],"z":1}').digest('hex'));
  const { privateKey } = generateKeyPairSync('ed25519');
  assert.deepEqual(sign('request', value, privateKey), sign('request', { a: ['한글', true], z: 1 }, privateKey));
  assert.throws(() => canonical(-0), /INVALID_NUMBER/);
  assert.throws(() => canonical('e\u0301'), /NON_CANONICAL_STRING/);
});

test('customer request creation is offline and validates policy, schema and amount', () => {
  const { logClient, customerKeys, request } = setup();
  const envelope = request('offline', 1_000_000);
  assert.equal(envelope.domain, 'request');
  assert.equal(envelope.payload.id, 'offline');
  assert.equal(envelope.payload.policyHash, hash(POLICY));
  assert.equal(logClient.calls.length, 0);
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createRequest({
      id: 'bad', amount, policy: POLICY, customerPrivateKey: customerKeys.privateKey,
    }), /INVALID_AMOUNT|INVALID_NUMBER/);
  }
  assert.throws(() => createRequest({
    id: 'bad id', amount: 1, policy: POLICY, customerPrivateKey: customerKeys.privateKey,
  }), /INVALID_REQUEST/);
  assert.throws(() => createRequest({
    id: 'bad-policy', amount: 1, policy: { ...POLICY, limit: 2 }, customerPrivateKey: customerKeys.privateKey,
  }), /UNSUPPORTED_POLICY/);
});

test('institution decisions preserve the transfer limit boundaries', async () => {
  for (const amount of [999_999, 1_000_000, 1_000_001]) {
    const { institution, request } = setup();
    const result = await institution.decide(await institution.accept(request(`boundary-${amount}`, amount)));
    const verificationContext = await institution.getVerificationContext(result.checkpointId);
    assert.equal(
      verifySingle(result, verificationContext).outcome,
      amount > 1_000_000 ? 'REJECTED' : 'APPROVED'
    );
  }
});

test('institution exposes only role methods and never receives the customer private key', () => {
  const { institution } = setup();
  assert.deepEqual(Object.keys(institution).sort(), ['accept', 'decide', 'exportLog', 'getVerificationContext']);
  assert.equal(Object.hasOwn(institution, 'keys'), false);
  assert.equal(Object.hasOwn(institution, 'entries'), false);
});

test('accept validates before registration and returns an independently verifiable receipt', async () => {
  const { logClient, institution, request } = setup();
  const receipt = await institution.accept(request('accepted', 1_500_000));
  const verificationContext = await institution.getVerificationContext(receipt.checkpointId);
  assert.equal(logClient.calls.length, 1);
  assert.equal(logClient.calls[0].method, 'registerRequest');
  assert.equal(receipt.request.entry.record.actor, logClient.context.institutionAddress);
  assert.deepEqual(verifyReceipt(disk(receipt), disk(verificationContext)), {
    ok: true, requestId: 'accepted', index: 0,
  });
});

test('invalid signatures, contexts and duplicate IDs are rejected before registration', async () => {
  const { logClient, customerKeys, institutionKeys, institution, request } = setup();
  const valid = request('unique', 10);
  const wrongSignature = sign('request', valid.payload, institutionKeys.privateKey);
  const wrongContext = sign('request', { ...valid.payload, institution: 'other' }, customerKeys.privateKey);
  const invalidAmount = sign('request', { ...valid.payload, amount: 0 }, customerKeys.privateKey);
  for (const [envelope, error] of [
    [wrongSignature, /INVALID_SIGNATURE/],
    [wrongContext, /REQUEST_CONTEXT_MISMATCH/],
    [invalidAmount, /INVALID_AMOUNT/],
  ]) await assert.rejects(institution.accept(envelope), error);
  assert.equal(logClient.calls.length, 0);

  await institution.accept(valid);
  await assert.rejects(institution.accept(request('unique', 20)), /DUPLICATE_REQUEST/);
  assert.equal(logClient.calls.length, 1);
});

test('decision verifies the receipt and returns request and decision proofs', async () => {
  const { logClient, institution, request } = setup();
  const receipt = await institution.accept(request('decision', 1_500_000));
  logClient.time = 1010;
  const result = await institution.decide(disk(receipt));
  const verificationContext = await institution.getVerificationContext(result.checkpointId);
  assert.deepEqual(verifySingle(disk(result), disk(verificationContext)), {
    ok: true,
    requestId: 'decision',
    amount: 1_500_000,
    outcome: 'REJECTED',
    reason: 'LIMIT_EXCEEDED',
  });
  assert.equal(result.request.entry.record.index, 0n);
  assert.equal(result.decision.entry.record.requestIndex, 0n);
  assert.equal(result.request.proof.length, 6);
  assert.equal(result.decision.proof.length, 6);
  await assert.rejects(institution.decide(receipt), /DUPLICATE_DECISION/);
  assert.equal(logClient.calls.length, 2);
});

test('decision refuses altered or unavailable receipts before registering', async () => {
  const { logClient, institution, request } = setup();
  const receipt = await institution.accept(request('checked', 10));
  const calls = logClient.calls.length;
  for (const mutate of [
    value => value.request.proof.pop(),
    value => { value.request.entry.payloadBytes = '0x00'; },
    value => { value.request.entry.record.recordedAt++; },
    value => { value.checkpointId++; },
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed);
    await assert.rejects(institution.decide(changed));
  }
  assert.equal(logClient.calls.length, calls);

  const forged = structuredClone(receipt);
  forged.request.entry.record.recordedAt--;
  const tree = buildTree([forged.request.entry.record], logClient.context);
  forged.request.proof = tree.proof(0);
  await assert.rejects(institution.decide(forged), /INVALID_INCLUSION_PROOF/);
  assert.equal(logClient.calls.length, calls);
});

test('decision uses a receipt snapshot across the asynchronous checkpoint read', async () => {
  const { logClient, institution, request } = setup();
  const receipt = await institution.accept(request('snapshot', 1));
  const readCheckpoint = logClient.readCheckpoint;
  logClient.readCheckpoint = async id => {
    receipt.request.entry.payloadBytes = '0x00';
    receipt.request.proof.length = 0;
    return readCheckpoint(id);
  };
  const result = await institution.decide(receipt);
  const verificationContext = await institution.getVerificationContext(result.checkpointId);
  assert.equal(verifySingle(result, verificationContext).outcome, 'APPROVED');
});

test('returned evidence, exported logs and callback values cannot mutate institution state', async () => {
  const observed = [];
  const { institution, request } = setup({ callbacks: {
    onPayload(_bytes, envelope) {
      envelope.payload.amount = 999;
    },
    onAppend(entries) {
      observed.push(entries);
      entries.length = 0;
    },
  } });
  const receipt = await institution.accept(request('copies', 10));
  const checkpointId = receipt.checkpointId;
  receipt.request.entry.payloadBytes = '0x00';
  const first = await institution.exportLog(checkpointId);
  assert.equal(decodePayload(first[0].payloadBytes, first[0].record).payload.amount, 10);
  assert.equal(observed[0].length, 0);
  first[0].payloadBytes = '0x00';
  const second = await institution.exportLog(checkpointId);
  assert.notEqual(second[0].payloadBytes, '0x00');
  const verificationContext = await institution.getVerificationContext(checkpointId);
  verificationContext.policy.limit = 1;
  assert.equal((await institution.getVerificationContext(checkpointId)).policy.limit, 1_000_000);
});

test('audit uses institution registration time and preserves checkpoint boundaries', async () => {
  const { logClient, institution, request } = setup();
  const receipt = await institution.accept(request('unanswered', 100));
  const acceptedAt = receipt.request.entry.record.recordedAt;
  logClient.time = Number(acceptedAt + 59n);
  const beforeCheckpoint = await logClient.createCheckpoint();
  const before = await institution.getVerificationContext(beforeCheckpoint.checkpointId);
  const beforeLog = await institution.exportLog(before.checkpointId);
  assert.deepEqual(audit(beforeLog, before).pending, ['unanswered']);
  logClient.time = Number(acceptedAt + 60n);
  const dueCheckpoint = await logClient.createCheckpoint();
  const due = await institution.getVerificationContext(dueCheckpoint.checkpointId);
  const dueLog = await institution.exportLog(due.checkpointId);
  assert.deepEqual(audit(dueLog, due).overdue, ['unanswered']);
  logClient.time++;
  const result = await institution.decide(receipt);
  const after = await institution.getVerificationContext(result.checkpointId);
  assert.deepEqual(audit(await institution.exportLog(after.checkpointId), after).overdue, []);
  assert.deepEqual(audit(beforeLog, before).pending, ['unanswered']);
  assert.deepEqual(audit(dueLog, due).overdue, ['unanswered']);
});

test('audit keeps deadline precision beyond the safe integer boundary', async () => {
  const { logClient, institution, request } = setup();
  logClient.time = Number.MAX_SAFE_INTEGER;
  const receipt = await institution.accept(request('large-deadline', 1));
  const verificationContext = await institution.getVerificationContext(receipt.checkpointId);
  const entries = await institution.exportLog(receipt.checkpointId);
  const deadline = receipt.request.entry.record.recordedAt + 60n;
  const at = issuedAt => ({ ...verificationContext, checkpoint: { ...verificationContext.checkpoint, issuedAt } });
  assert.deepEqual(audit(entries, at(deadline - 1n)).pending, ['large-deadline']);
  assert.deepEqual(audit(entries, at(deadline)).overdue, ['large-deadline']);
});

test('exportLog returns exactly the selected checkpoint prefix', async () => {
  const { institution, request } = setup();
  const first = await institution.accept(request('first', 1));
  const firstLog = await institution.exportLog(first.checkpointId);
  const decision = await institution.decide(first);
  await institution.accept(request('second', 2));
  assert.equal(firstLog.length, 1);
  assert.equal((await institution.exportLog(first.checkpointId)).length, 1);
  assert.equal((await institution.exportLog(decision.checkpointId)).length, 2);
});

test('exportLog requires an explicit checkpoint and never creates one implicitly', async () => {
  const { logClient, institution } = setup();
  let checkpoints = 0;
  const checkpoint = logClient.createCheckpoint;
  logClient.createCheckpoint = async () => {
    checkpoints++;
    return checkpoint();
  };
  await assert.rejects(institution.exportLog(), /CHECKPOINT_REQUIRED/);
  await assert.rejects(institution.exportLog(null), /CHECKPOINT_REQUIRED/);
  assert.equal(checkpoints, 0);
});

test('verification context reads require an existing checkpoint and never publish one', async () => {
  const { logClient, institution, request } = setup();
  const receipt = await institution.accept(request('read-only-context', 1));
  const original = await institution.getVerificationContext(receipt.checkpointId);
  logClient.time += 60;
  const later = await logClient.createCheckpoint();
  logClient.createCheckpoint = async () => assert.fail('UNEXPECTED_CHECKPOINT_CREATION');

  await assert.rejects(institution.getVerificationContext(), /CHECKPOINT_REQUIRED/);
  await assert.rejects(institution.getVerificationContext(null), /CHECKPOINT_REQUIRED/);
  await assert.rejects(institution.getVerificationContext(later.checkpointId + 1n), /CHECKPOINT_NOT_FOUND/);
  assert.deepEqual(await institution.getVerificationContext(receipt.checkpointId), original);
  const current = await institution.getVerificationContext(later.checkpointId);
  assert.equal(current.checkpoint.issuedAt, original.checkpoint.issuedAt + 60n);
  assert.equal(current.checkpoint.root, original.checkpoint.root);
  assert.deepEqual(await logClient.readLatestCheckpoint(), {
    checkpointId: later.checkpointId, checkpoint: later.checkpoint,
  });
});

test('receipt generation fails when the institution log is missing an earlier contract record', async () => {
  const logClient = createTestWitness();
  logClient.record(encodePayload({ foreign: true }));
  const { institution, request } = setup({ logClient });
  await assert.rejects(institution.accept(request('incomplete-log', 1)), error => {
    assert.equal(error.message, 'LOG_SIZE_MISMATCH');
    assert.match(error.txHash, /^0x/);
    assert.equal(error.registration.entry.index, 1n);
    return true;
  });
  assert.equal(logClient.calls.length, 1, 'the accepted request was registered before proof generation failed');
});

test('post-registration receipt failures preserve registration details and prevent blind retries', async () => {
  const { logClient, institution, request } = setup();
  const readCheckpoint = logClient.readCheckpoint;
  logClient.readCheckpoint = async () => { throw new Error('CHECKPOINT_READ_FAILED'); };
  let failure;
  await assert.rejects(institution.accept(request('registered-request', 1)), error => {
    failure = error;
    assert.equal(error.message, 'CHECKPOINT_READ_FAILED');
    assert.match(error.txHash, /^0x/);
    assert.equal(error.registration.entry.index, 0n);
    return true;
  });
  logClient.readCheckpoint = readCheckpoint;
  failure.registration.entry.index = 99n;
  assert.equal((await institution.exportLog(0n))[0].record.index, 0n);
  await assert.rejects(institution.accept(request('registered-request', 1)), /DUPLICATE_REQUEST/);
  assert.equal(logClient.calls.length, 1);
});

test('post-registration decision failures preserve registration details', async () => {
  const { logClient, institution, request } = setup();
  const receipt = await institution.accept(request('registered-decision', 1));
  const readCheckpoint = logClient.readCheckpoint;
  logClient.readCheckpoint = async id => {
    if (BigInt(id) !== BigInt(receipt.checkpointId)) throw new Error('DECISION_CHECKPOINT_READ_FAILED');
    return readCheckpoint(id);
  };
  await assert.rejects(institution.decide(receipt), error => {
    assert.equal(error.message, 'DECISION_CHECKPOINT_READ_FAILED');
    assert.match(error.txHash, /^0x/);
    assert.equal(error.registration.entry.kind, 1n);
    return true;
  });
  logClient.readCheckpoint = readCheckpoint;
  await assert.rejects(institution.decide(receipt), /DUPLICATE_DECISION/);
  assert.equal(logClient.calls.length, 2);
});

test('tampering, wrong keys, false policy outcomes and incomplete logs are detected', async () => {
  const { bundle, verificationContext, entries } = await fixture();
  const changed = structuredClone(bundle);
  changed.decision.entry.payloadBytes = encodePayload({
    ...decodePayload(changed.decision.entry.payloadBytes, changed.decision.entry.record),
    signature: 'AAAA',
  });
  assert.throws(() => verifySingle(changed, verificationContext));
  const wrongKey = generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => verifySingle(bundle, { ...verificationContext, institutionKey: wrongKey }), /INVALID_SIGNATURE/);
  assert.throws(() => audit(entries.slice(1), verificationContext), /LOG_SIZE_MISMATCH/);
  assert.throws(() => audit([...entries].reverse(), verificationContext), /INVALID_LOG_ORDER/);
});

test('valid proofs cannot combine a request with another request decision', async () => {
  const { institution, request } = setup();
  const first = await institution.decide(await institution.accept(request('first-link', 1)));
  const second = await institution.decide(await institution.accept(request('second-link', 2)));
  const verificationContext = await institution.getVerificationContext(second.checkpointId);
  const entries = await institution.exportLog(second.checkpointId);
  const mixed = buildTree(entries.map(entry => entry.record), verificationContext);
  const bundle = {
    checkpointId: verificationContext.checkpointId,
    request: { entry: first.request.entry, proof: mixed.proof(first.request.entry.record.index) },
    decision: { entry: second.decision.entry, proof: mixed.proof(second.decision.entry.record.index) },
  };
  assert.throws(() => verifySingle(bundle, verificationContext), /DECISION_LINK_MISMATCH/);
});

test('persistence order is payload, registration, append, then internal visibility', async () => {
  const logClient = createTestWitness();
  const events = [];
  const original = logClient.registerRequest;
  logClient.registerRequest = async bytes => {
    events.push('register');
    return original(bytes);
  };
  const { institution, request } = setup({ logClient, callbacks: {
    onPayload() { events.push('payload'); },
    async onAppend(entries) {
      events.push(`append:${entries.length}`);
      assert.equal((await institution.exportLog(0n)).length, 0);
    },
  } });
  await institution.accept(request('ordered', 1));
  assert.deepEqual(events, ['payload', 'register', 'append:1']);
  assert.equal((await institution.exportLog(0n)).length, 1);
});

test('pre-registration and post-registration persistence failures retain existing failure semantics', async () => {
  const before = setup({ callbacks: { onPayload() { throw new Error('DISK_FAILURE'); } } });
  await assert.rejects(before.institution.accept(before.request('before', 1)), /DISK_FAILURE/);
  assert.equal(before.logClient.calls.length, 0);

  const after = setup({ callbacks: { onAppend() { throw new Error('DISK_FAILURE'); } } });
  await assert.rejects(after.institution.accept(after.request('after', 1)), error => {
    assert.equal(error.message, 'DISK_FAILURE');
    assert.match(error.txHash, /^0x/);
    assert(error.registration);
    return true;
  });
  assert.equal(after.logClient.calls.length, 1);
});

test('registration send failures leave the institution log unchanged and permit explicit retries', async () => {
  for (const status of ['FAILED', 'NOT_SENT', 'UNKNOWN']) {
    const { logClient, institution, request } = setup();
    const registerRequest = logClient.registerRequest;
    logClient.registerRequest = async () => {
      throw Object.assign(new Error('SEND_FAILED'), { registrationStatus: status });
    };
    await assert.rejects(institution.accept(request(`retry-${status}`, 1)), error => {
      assert.equal(error.registrationStatus, status);
      return true;
    });
    logClient.registerRequest = registerRequest;
    const receipt = await institution.accept(request(`retry-${status}`, 1));
    assert.equal(verifyReceipt(receipt, await institution.getVerificationContext(receipt.checkpointId)).ok, true);
    assert.equal((await institution.exportLog(receipt.checkpointId)).length, 1);
  }
});

test('persistence errors expose a stable registration copy', async () => {
  const logClient = createTestWitness();
  let source;
  let originalTxHash;
  const registerRequest = logClient.registerRequest;
  logClient.registerRequest = async bytes => {
    source = await registerRequest(bytes);
    originalTxHash = source.txHash;
    return source;
  };
  const { institution, request } = setup({ logClient, callbacks: {
    onAppend() {
      source.txHash = 'changed-after-registration';
      throw new Error('DISK_FAILURE');
    },
  } });
  await assert.rejects(institution.accept(request('stable-error', 1)), error => {
    assert.equal(error.txHash, originalTxHash);
    assert.notEqual(error.registration, source);
    error.registration.entry.index = 99n;
    assert.equal(source.entry.index, 0n);
    return true;
  });
});
