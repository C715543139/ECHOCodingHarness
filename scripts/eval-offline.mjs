#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', 'tests/evals'], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

process.stdout.write('Offline Fake Provider evals passed.\n');
