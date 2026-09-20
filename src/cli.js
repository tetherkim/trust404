import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { resolve, join } from 'node:path';
import { Contract, JsonRpcProvider } from 'ethers';
import {
  audit, buildBundle, createInstitution, createRequest, decodePayload, encodePayload,
  hash, sign, validatePolicy, verifyReceipt, verifySingle
} from './evidence.js';
import { checkEvmContext, deployEvmWitness, evidenceLogArtifact, readCheckpoint } from './evm.js';

const read = path => JSON.parse(readFileSync(path, 'utf8'));

function readVerificationContext(path) {
  const verificationContext = read(path);
  validatePolicy(verificationContext.policy);

  return verificationContext;
}

const json = value => JSON.stringify(
  value,
  (_, item) => typeof item === 'bigint' ? item.toString() : item,
  2
);

function write(path, value) {
  writeFileSync(`${path}.tmp`, json(value) + '\n', { flag: 'wx', flush: true });
  renameSync(`${path}.tmp`, path);
}

async function demo(destination) {
  if (!process.env.RPC_URL) throw new Error('RPC_URL_REQUIRED');

  const out = resolve(destination ?? `demo-output-${Date.now()}`);

  mkdirSync(out);

  for (const dir of ['customer', 'institution', 'witness', 'auditor', 'attacks'])
    mkdirSync(join(out, dir));

  const logClient = await deployEvmWitness({ rpcUrl: process.env.RPC_URL });
  let auditorProvider;
  let witnessOpen = true;

  try {
    const policy = {
      version: 1,
      id: 'per-transfer-limit-v1',
      institution: 'demo-bank',
      currency: 'KRW',
      limit: 1000000,
      decisionWindow: 60
    };

    const customerKeys = generateKeyPairSync('ed25519');
    const institutionKeys = generateKeyPairSync('ed25519');
    const customerKey = customerKeys.publicKey.export({ type: 'spki', format: 'pem' });
    const institutionKey = institutionKeys.publicKey.export({ type: 'spki', format: 'pem' });

    const artifact = await evidenceLogArtifact();
    auditorProvider = new JsonRpcProvider(process.env.RPC_URL);
    const auditorLog = new Contract(logClient.context.evidenceLogAddress, artifact.abi, auditorProvider);
    const auditorContext = await checkEvmContext(auditorLog, logClient.context);

    const baseVerificationContext = {
      ...auditorContext,
      policy,
      customerKey,
      institutionKey,
    };

    const getVerificationContext = async checkpointId => {
      const selectedCheckpoint = await readCheckpoint(auditorLog, checkpointId);

      return structuredClone({ ...baseVerificationContext, ...selectedCheckpoint });
    };

    const institution = createInstitution({
      logClient,
      policy,
      institutionKeys,
      customerKey,
      onPayload: (bytes, envelope) => write(
        join(
          out,
          'institution',
          envelope.domain === 'request'
            ? `${envelope.payload.id}-request.json`
            : `${envelope.payload.requestHash}-decision.json`
        ),
        bytes
      ),
      onAppend: entries => write(join(out, 'institution/full-log.json'), entries)
    });

    const request = (id, amount) => createRequest({
      id, amount, policy, customerPrivateKey: customerKeys.privateKey
    });

    write(join(out, 'context.json'), logClient.context);
    write(join(out, 'auditor/context.json'), auditorContext);

    const receipt = await institution.accept(request('transfer-rejected', 1500000));
    const receiptVerificationContext = await getVerificationContext(receipt.checkpointId);

    write(join(out, 'customer/receipt.json'), receipt);
    write(join(out, 'customer/receipt-verification-context.json'), receiptVerificationContext);

    const rejection = await institution.decide(receipt);
    const decision = rejection.decision.entry;
    const rejectionVerificationContext = await getVerificationContext(rejection.checkpointId);

    write(join(out, 'customer/rejection.json'), rejection);
    write(join(out, 'customer/rejection-verification-context.json'), rejectionVerificationContext);

    const approvalReceipt = await institution.accept(request('transfer-approved', 500000));
    const approval = await institution.decide(approvalReceipt);
    const approvalVerificationContext = await getVerificationContext(approval.checkpointId);

    write(join(out, 'customer/approval.json'), approval);
    write(join(out, 'customer/approval-verification-context.json'), approvalVerificationContext);

    const verificationContext = await getVerificationContext();
    const normalEntries = await institution.exportLog(verificationContext.checkpointId);

    write(join(out, 'auditor/verification-context.json'), verificationContext);
    write(join(out, 'auditor/submission.json'), normalEntries);
    write(join(out, 'witness/checkpoint.json'), verificationContext.checkpoint);
    write(join(out, 'institution/decisions.json'), [decision, approval.decision.entry]);

    const tampered = structuredClone(rejection);
    const altered = decodePayload(decision.payloadBytes, decision.record);
    altered.payload.reason = 'CHANGED_LATER';
    tampered.decision.entry.payloadBytes = encodePayload(altered);

    write(join(out, 'attacks/tampered.json'), tampered);

    const forged = structuredClone(rejection);
    const unsigned = decodePayload(decision.payloadBytes, decision.record);
    unsigned.signature = 'AAAA';
    forged.decision.entry.payloadBytes = encodePayload(unsigned);

    write(join(out, 'attacks/forged-signature.json'), forged);

    write(
      join(out, 'attacks/deleted-log.json'),
      normalEntries.filter(e => e.record.index !== decision.record.index)
    );

    await institution.accept(request('unanswered', 1500000));

    // increase block timestamp
    const clock = new JsonRpcProvider(process.env.RPC_URL);

    try {
      await clock.send('evm_increaseTime', [policy.decisionWindow]);
    } finally {
      clock.destroy();
    }

    const missingCheckpoint = await logClient.createCheckpoint();
    const missingVerificationContext = await getVerificationContext(missingCheckpoint.checkpointId);
    const missingEntries = await institution.exportLog(missingVerificationContext.checkpointId);

    write(join(out, 'attacks/missing-log.json'), missingEntries);
    write(join(out, 'attacks/missing-verification-context.json'), missingVerificationContext);

    const wrongPolicyReceipt = await institution.accept(request('wrong-policy', 1500000));
    const wrongPolicyRequest = wrongPolicyReceipt.request.entry;
    const wrongPolicyBytes = encodePayload(sign('decision', {
      version: 1,
      requestHash: hash(decodePayload(wrongPolicyRequest.payloadBytes, wrongPolicyRequest.record)),
      policyHash: hash(policy),
      outcome: 'APPROVED',
      reason: 'WITHIN_LIMIT'
    }, institutionKeys.privateKey));

    write(join(out, 'attacks/wrong-policy-decision.json'), wrongPolicyBytes);

    const registration = await logClient.registerDecision(wrongPolicyRequest.record.index, wrongPolicyBytes);
    const wrongPolicyDecision = {
      payloadBytes: wrongPolicyBytes,
      record: registration.entry,
      checkpointId: registration.checkpointId
    };

    const wrongPolicyVerificationContext = await getVerificationContext(registration.checkpointId);
    const wrongPolicyEntries = [
      ...await institution.exportLog(wrongPolicyReceipt.checkpointId),
      wrongPolicyDecision
    ];

    const wrongPolicyResult = buildBundle(
      wrongPolicyEntries, wrongPolicyRequest, wrongPolicyDecision, wrongPolicyVerificationContext
    );

    write(join(out, 'attacks/wrong-policy-result.json'), wrongPolicyResult);
    write(join(out, 'attacks/wrong-policy-verification-context.json'), wrongPolicyVerificationContext);

    writeFileSync(
      join(out, 'README.txt'),
      '송금 판단 검증 시연: 실제 송금 없이 EVM 체인의 EvidenceLog 계약에 요청·판단 해시를 등록합니다.\ncustomer: 기관이 반환한 고객 보관 증거와 증거별 독립 검증 기준\nauditor/verification-context.json: 별도 provider-only 연결로 확보한 체크포인트와 정책·공개키를 합친 검증 입력\nauditor/submission.json: 해당 체크포인트 범위의 감사 제출본\nwitness: 외부 기록 주체에서 독립 조회한 체크포인트\ninstitution/full-log.json: 기관이 보관한 전체 기록 (검증기는 읽지 않음)\nattacks: 공격별 시연 파일과 해당 감사 범위의 검증 기준\n시각과 순번은 계약 기록을 사용합니다. 미처리 시연에서는 Anvil의 블록 시각을 60초 진행하고 새 체크포인트를 생성합니다.\n실제 운영에서는 각 역할을 별도 환경에서 운영하고 공개키·체크포인트를 독립 경로로 전달해야 합니다.\n'
    );

    auditorProvider.destroy();
    auditorProvider = undefined;

    logClient.close();
    witnessOpen = false;

    const checks = [];
    const check = (name, fn, expected, expectedError) => {
      let actual;

      try {
        actual = fn().ok ? 'PASS' : 'DETECTED';
      } catch (error) {
        if (expectedError && error.message !== expectedError) throw error;
        actual = 'DETECTED';
      }

      if (actual !== expected) throw new Error(`DEMO_FAILED: ${name}`);
      checks.push({ name, result: actual });
    };

    check(
      '거절 단건 독립 검증',
      () => verifySingle(
        read(join(out, 'customer/rejection.json')),
        readVerificationContext(join(out, 'customer/rejection-verification-context.json'))
      ),
      'PASS'
    );

    check(
      '승인 단건 검증',
      () => verifySingle(
        read(join(out, 'customer/approval.json')),
        readVerificationContext(join(out, 'customer/approval-verification-context.json'))
      ),
      'PASS'
    );

    check('전체 범위 감사', () => audit(
      read(join(out, 'auditor/submission.json')),
      readVerificationContext(join(out, 'auditor/verification-context.json'))
    ), 'PASS');

    check('사유 변조', () => verifySingle(
      read(join(out, 'attacks/tampered.json')),
      readVerificationContext(join(out, 'customer/rejection-verification-context.json'))
    ), 'DETECTED');

    check('서명 위조', () => verifySingle(
      read(join(out, 'attacks/forged-signature.json')),
      readVerificationContext(join(out, 'customer/rejection-verification-context.json'))
    ), 'DETECTED');

    check(
      '목록 삭제',
      () => audit(
        read(join(out, 'attacks/deleted-log.json')),
        readVerificationContext(join(out, 'auditor/verification-context.json'))
      ),
      'DETECTED'
    );

    const missingReport = audit(
      read(join(out, 'attacks/missing-log.json')),
      readVerificationContext(join(out, 'attacks/missing-verification-context.json'))
    );
    check('접수 후 판단 누락', () => missingReport, 'DETECTED');

    check(
      '정책 위반 판단',
      () => verifySingle(
        read(join(out, 'attacks/wrong-policy-result.json')),
        readVerificationContext(join(out, 'attacks/wrong-policy-verification-context.json'))
      ),
      'DETECTED',
      'POLICY_MISMATCH'
    );

    return { ok: true, output: out, checks };
  } finally {
    auditorProvider?.destroy();
    if (witnessOpen) logClient.close();
  }
}

try {
  const [command, file, verificationContextFile, ...extra] = process.argv.slice(2);

  if (extra.length || (command === 'demo' && verificationContextFile)) throw new Error('INVALID_ARGUMENTS');

  let result;

  if (command === 'demo')
    result = await demo(file);
  else if (command === 'receipt' && file && verificationContextFile)
    result = verifyReceipt(read(file), readVerificationContext(verificationContextFile));
  else if (command === 'verify' && file && verificationContextFile)
    result = verifySingle(read(file), readVerificationContext(verificationContextFile));
  else if (command === 'audit' && file && verificationContextFile)
    result = audit(read(file), readVerificationContext(verificationContextFile));
  else
    throw new Error(
      'Usage: node src/cli.js demo [new-directory] | receipt|verify <bundle.json> <verification-context.json> | audit <log.json> <verification-context.json>'
    );

  console.log(json(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(json({
    ok: false,
    error: error.message.split('\n')[0],
    txHash: error.txHash,
    registrationStatus: error.registrationStatus
  }));

  process.exitCode = 1;
}
