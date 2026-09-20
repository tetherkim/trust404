import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopProcess } from '../scripts/local-process.js';

test('이미 신호로 종료된 자식 프로세스를 다시 기다리지 않는다', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, 'SIGTERM');
  await stopProcess(child);
});

test('종료 신호를 무시하는 자식도 제한 시간 내 정리하며 중복 종료를 공유한다', { timeout: 3000 }, async t => {
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => stopProcess(child, 50));
  await once(child, 'message');
  const first = stopProcess(child, 50), second = stopProcess(child, 50);
  assert.equal(first, second);
  await first;
  assert.equal(child.signalCode, 'SIGKILL');
});
