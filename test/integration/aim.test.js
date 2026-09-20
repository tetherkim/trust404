import test from 'node:test';
import { demonstrateAim } from '../../src/demo/aim.js';

test('[AIM] 독립 검증 시연: 기관 DB 읽기 권한이 차단된 격리 CLI에서 단건 거절 검증 및 4개 공격 사례 탐지', { timeout: 60000 }, async () => {
  await demonstrateAim(() => {});
});
