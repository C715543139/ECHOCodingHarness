import { copyFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { p3FixtureRoot, verifyProtectedInputs } from './p3-pdf-demo-lib.mjs';

await verifyProtectedInputs(p3FixtureRoot);
await copyFile(
  path.join(p3FixtureRoot, 'golden', 'score-summary.mjs'),
  path.join(p3FixtureRoot, 'src', 'score-summary.mjs'),
);
await rm(path.join(p3FixtureRoot, '.echo'), { recursive: true, force: true });
console.log('P3 synthetic PDF demo reset. Protected hashes verified.');
