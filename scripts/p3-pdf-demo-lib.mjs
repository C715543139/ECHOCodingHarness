import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const repositoryRoot = path.resolve(import.meta.dirname, '..');
export const p3FixtureRoot = path.join(repositoryRoot, 'fixtures', 'p3-pdf-demo');

export async function verifyProtectedInputs(workspaceRoot) {
  const lock = JSON.parse(await readFile(path.join(workspaceRoot, 'evidence-lock.json'), 'utf8'));
  const actual = {};
  for (const [relativePath, expected] of Object.entries(lock.files)) {
    const content = await readFile(path.join(workspaceRoot, ...relativePath.split('/')));
    const digest = createHash('sha256').update(content).digest('hex');
    actual[relativePath] = digest;
    if (digest !== expected) throw new Error(`Protected input changed: ${relativePath}`);
  }
  return actual;
}

export async function runIndependentTest(workspaceRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'test/score-summary.test.mjs'], {
      cwd: workspaceRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code ?? 1, output }));
  });
}
