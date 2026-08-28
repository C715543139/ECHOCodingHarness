import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const demoRoot = path.join(repoRoot, 'fixtures', 'demo');
const goldenRoot = path.join(demoRoot, 'golden');

await mkdir(path.join(demoRoot, 'src'), { recursive: true });
await mkdir(path.join(demoRoot, 'test'), { recursive: true });
await copyFile(
  path.join(goldenRoot, 'parse-report.ts'),
  path.join(demoRoot, 'src', 'parse-report.ts'),
);
await copyFile(
  path.join(goldenRoot, 'parse-report.test.ts'),
  path.join(demoRoot, 'test', 'parse-report.test.ts'),
);

process.stdout.write('Demo fixture reset to the failing parser tests.\n');
