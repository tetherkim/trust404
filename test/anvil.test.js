import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider } from 'ethers';
import {
  audit,
  createInstitution,
  createRequest,
  sign,
  verifyReceipt,
  verifySingle,
} from '../src/evidence.js';
import { checkEvmContext, createEvmLogClient, payloadHash, readCheckpoint } from '../src/evm.js';
import { POLICY } from './helpers.js';

const artifactPath = fileURLToPath(new URL('../contracts/out/EvidenceLog.sol/EvidenceLog.json', import.meta.url));

async function bounded(promise, label, timeout = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function availablePort() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
  } finally {
    if (server.listening) await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

async function startAnvil(directory) {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
    '--timestamp', '1900000000', '--silent',
  ], { cwd: directory, env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Anvil exited before readiness: ${output}`);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(500),
      });
      if ((await response.json()).result === '0x7a69') break;
    } catch {
      // Retry only while the owned local process starts.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (Date.now() >= deadline) throw new Error(`Anvil readiness timed out: ${output}`);

  return {
    url,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await bounded(new Promise(resolve => child.once('close', resolve)), 'Anvil shutdown');
    },
  };
}

test('institution acceptance protocol against a dedicated local Anvil', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'trust404-anvil-'));
  const anvil = await startAnvil(directory);
  const connection = new FetchRequest(anvil.url);
  connection.timeout = 5_000;
  const provider = new JsonRpcProvider(connection, 31337, {
    cacheTimeout: -1,
    batchMaxCount: 1,
    pollingInterval: 20,
    staticNetwork: true,
  });
  t.after(async () => {
    provider.destroy();
    await anvil.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  const [deployer, institutionSigner, outsider] = await Promise.all([
    provider.getSigner(0), provider.getSigner(1), provider.getSigner(2),
  ]);
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, deployer)
    .deploy(await institutionSigner.getAddress(), 6);
  const deployment = await bounded(contract.deploymentTransaction().wait(), 'contract deployment');
  const logClient = await createEvmLogClient({
    evidenceLog: contract,
    institutionSigner,
    deploymentBlock: deployment.blockNumber,
  });
  const auditorProvider = new JsonRpcProvider(anvil.url);
  t.after(() => auditorProvider.destroy());
  const auditorLog = new Contract(logClient.context.evidenceLogAddress, artifact.abi, auditorProvider);
  assert.deepEqual(await checkEvmContext(auditorLog, logClient.context), logClient.context);
  assert.equal(Object.hasOwn(logClient.context, 'customerAddress'), false);

  const customerKeys = generateKeyPairSync('ed25519');
  const institutionKeys = generateKeyPairSync('ed25519');
  const customerKey = customerKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const saved = [];
  const service = createInstitution({
    logClient,
    policy: POLICY,
    institutionKeys,
    customerKey,
    onAppend(entries) { saved.push(entries); },
  });
  assert.deepEqual(Object.keys(service).sort(), ['accept', 'decide', 'exportLog', 'getVerificationContext']);

  const directHash = payloadHash('0x1234');
  for (const signer of [deployer, outsider]) {
    const unauthorized = contract.connect(signer);
    await assert.rejects(async () => {
      const transaction = await unauthorized.registerRequest(directHash, { gasLimit: 500_000n });
      await transaction.wait();
    });
  }
  assert.equal(await contract.size(), 0n);

  const envelope = createRequest({
    id: 'accepted',
    amount: 1_500_000,
    policy: POLICY,
    customerPrivateKey: customerKeys.privateKey,
  });
  assert.equal(await contract.size(), 0n, 'creating a customer request must not register it');
  const receipt = await service.accept(envelope);
  const receiptVerificationContext = await service.getVerificationContext(receipt.checkpointId);
  const independentReceipt = await readCheckpoint(auditorLog, receipt.checkpointId);
  const latestReceipt = await readCheckpoint(auditorLog);
  assert.equal(await contract.size(), 1n);
  assert.equal(receipt.request.entry.record.actor, await institutionSigner.getAddress());
  assert.equal(verifyReceipt(receipt, receiptVerificationContext).ok, true);
  assert.deepEqual(independentReceipt.checkpoint, receiptVerificationContext.checkpoint);
  assert.deepEqual(latestReceipt, independentReceipt);

  const wrong = sign('request', envelope.payload, institutionKeys.privateKey);
  await assert.rejects(service.accept(wrong), /INVALID_SIGNATURE/);
  await assert.rejects(service.accept(createRequest({
    id: 'accepted',
    amount: 10,
    policy: POLICY,
    customerPrivateKey: customerKeys.privateKey,
  })), /DUPLICATE_REQUEST/);
  assert.equal(await contract.size(), 1n, 'invalid acceptance must fail before registration');

  const decisionReceipt = await service.decide(receipt);
  const decisionVerificationContext = await service.getVerificationContext(decisionReceipt.checkpointId);
  assert.deepEqual(verifySingle(decisionReceipt, decisionVerificationContext), {
    ok: true,
    requestId: 'accepted',
    amount: 1_500_000,
    outcome: 'REJECTED',
    reason: 'LIMIT_EXCEEDED',
  });
  assert.equal(decisionReceipt.decision.entry.record.actor, await institutionSigner.getAddress());
  await assert.rejects(service.decide(receipt), /DUPLICATE_DECISION/);
  const completeLog = await service.exportLog(decisionReceipt.checkpointId);
  assert.equal(audit(completeLog, decisionVerificationContext).ok, true);

  receipt.request.entry.payloadBytes = '0x00';
  saved[0].length = 0;
  assert.equal((await service.exportLog(receipt.checkpointId)).length, 1);

  const pendingReceipt = await service.accept(createRequest({
    id: 'pending',
    amount: 1,
    policy: POLICY,
    customerPrivateKey: customerKeys.privateKey,
  }));
  const recordedAt = Number(pendingReceipt.request.entry.record.recordedAt);
  await provider.send('evm_setNextBlockTimestamp', [recordedAt + 59]);
  const beforeCheckpoint = await logClient.createCheckpoint();
  const before = await service.getVerificationContext(beforeCheckpoint.checkpointId);
  const beforeLog = await service.exportLog(before.checkpointId);
  assert.deepEqual(audit(beforeLog, before).pending, ['pending']);
  await provider.send('evm_setNextBlockTimestamp', [recordedAt + 60]);
  const dueCheckpoint = await logClient.createCheckpoint();
  const due = await service.getVerificationContext(dueCheckpoint.checkpointId);
  const dueLog = await service.exportLog(due.checkpointId);
  assert.deepEqual(audit(dueLog, due).overdue, ['pending']);

  await service.decide(pendingReceipt);
  assert.deepEqual(audit(dueLog, due).overdue, ['pending'], 'past audit scope must remain unchanged');
});
