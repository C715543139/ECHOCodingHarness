import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeScores } from '../src/score-summary.mjs';

test('summarizes a non-empty score list', () => {
  assert.deepEqual(summarizeScores([4, 8, 12]), {
    total: 24,
    average: 8,
    highest: 12,
  });
});

test('uses the specified empty-list values', () => {
  assert.deepEqual(summarizeScores([]), {
    total: 0,
    average: 0,
    highest: null,
  });
});
