import test from 'node:test';
import { demonstrateAim } from '../../src/demo/aim.js';

test('AIM: independent CLI verifies rejection and detects attacks with institution DB access denied', { timeout: 60000 }, async () => {
  await demonstrateAim(() => {});
});
