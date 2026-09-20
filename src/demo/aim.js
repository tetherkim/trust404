import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemo } from './local.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));

// Only disposable demo data is removed. Never accepts an operator directory or key.
export async function demonstrateAim(report = console.log, { signal } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'trust404-aim-'));
  let demo;
  try {
    demo = await startDemo({ port: 0, directory, profileFile: null, deploymentPublisher: null, signal, report });
    const { scenarios } = await (await fetch(`${demo.url}/api/status`)).json();
    const auditor = join(directory, 'auditor');
    for (const scenario of scenarios) {
      const source = join(demo.runDirectory, scenario.id), target = join(auditor, scenario.id);
      mkdirSync(target, { recursive: true });
      cpSync(join(source, 'audit-copy'), join(target, 'archive'), { recursive: true });
      cpSync(join(source, 'trust.json'), join(target, 'trust.json'));
      if (scenario.id === 'rejection') cpSync(join(source, 'evidence.json'), join(target, 'evidence.json'));
      writeFileSync(join(target, 'config.json'), JSON.stringify({
        trustFile: 'trust.json', archiveDirectory: 'archive', rpcUrl: demo.rpcUrl, asOf: scenario.asOf.blockHash,
      }));
    }
    // Institution files remain intact. The independent verifier can read only
    // its public evidence/config and application code, never institution data.
    const permissions = ['--permission',
      `--allow-fs-read=${join(root, 'src')}`, `--allow-fs-read=${join(root, 'node_modules')}`,
      `--allow-fs-read=${join(root, 'package.json')}`, `--allow-fs-read=${auditor}`];
    const database = join(demo.runDirectory, 'rejection', 'records.sqlite');
    assert.equal(existsSync(database), true);
    await assert.rejects(exec(process.execPath, [...permissions, '-e',
      'require("node:fs").readFileSync(process.argv[1])', database], { cwd: auditor, signal, timeout: 5000 }),
    error => error.code === 1 && /ERR_ACCESS_DENIED/.test(error.stderr));
    report('PASS 기관 DB 보존 · 검증 프로세스의 기관 DB 읽기 권한 차단');
    const run = async (id, command, expectedExit) => {
      const folder = join(auditor, id);
      const args = [...permissions, cli, command, join(folder, 'config.json')];
      if (command === 'verify') args.push(join(folder, 'evidence.json'));
      let output, code = 0;
      try { output = await exec(process.execPath, args, { cwd: auditor, signal, timeout: 20000 }); }
      catch (error) { output = error; code = error.code; }
      assert.equal(code, expectedExit, output.stderr);
      return JSON.parse(output.stdout);
    };
    const single = await run('rejection', 'verify', 0);
    assert.equal(single.outcome, 'REJECTED');
    assert.equal(single.reason, 'RESERVE_FLOOR');
    assert.equal(single.recordIntegrity.requestSignature, 'VALID');
    assert.equal(single.recordIntegrity.decisionSignature, 'VALID');
    report('PASS 별도 검증 프로세스에서 거절 한 건 확인 · 요청자/기관 서명 유효');
    assert.equal((await run('rejection', 'audit', 0)).complete, true);
    const tamper = await run('tamper', 'audit', 1);
    assert(tamper.issues.some(issue => issue.code === 'TAMPERED_EXPORT'));
    report('PASS 사후 판단 조작 탐지: TAMPERED_EXPORT');
    const unavailable = await run('unavailable', 'audit', 1);
    assert.equal(unavailable.complete, false);
    assert(unavailable.issues.some(issue => issue.code === 'DATA_UNAVAILABLE'));
    assert.equal(unavailable.requests[0].timing, 'UNKNOWN');
    report('PASS 등록된 판단 자료 삭제 탐지: DATA_UNAVAILABLE');
    const missing = await run('missing', 'audit', 1);
    assert.equal(missing.complete, true);
    assert.equal(missing.requests[0].timing, 'MISSING_AS_OF_H');
    report('PASS 접수 후 판단 미등록 탐지: MISSING_AS_OF_H');
    const wrong = await run('wrong', 'audit', 1);
    assert(wrong.issues.some(issue => issue.code === 'POLICY_MISMATCH'));
    report('PASS 기관이 서명한 잘못된 사유 탐지: POLICY_MISMATCH');
    assert.equal(existsSync(database), true);
    report('AIM 시연 완료: 로컬 체인·역할별 모의 키 사용, 실제 고객 인증이나 송금 없음');
  } finally {
    try { await demo?.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  demonstrateAim().catch(error => { console.error(error); process.exitCode = 1; });
}
