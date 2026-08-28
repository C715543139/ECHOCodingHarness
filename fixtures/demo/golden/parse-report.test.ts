import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseReport } from '../src/parse-report.ts';

test('parseReport counts failed tests in the total', () => {
  assert.deepEqual(parseReport('12 passed, 1 failed'), {
    passed: 12,
    failed: 1,
    total: 13,
  });
});

test('parseReport treats a clean run as fully passed', () => {
  assert.deepEqual(parseReport('12 passed, 0 failed'), {
    passed: 12,
    failed: 0,
    total: 12,
  });
});
