import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const demoRoot = path.join(repoRoot, 'fixtures', 'demo');
const testPath = path.join(demoRoot, 'test', 'parse-report.test.ts');
const resetScript = path.join(repoRoot, 'scripts', 'demo-reset.mjs');
const temporaryDirectories: string[] = [];

function resetDemo(): void {
  const result = spawnSync(process.execPath, [resetScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'demo reset failed');
  }
}

function runDemoTests(cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'test/parse-report.test.ts'],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
}

async function copyDemo(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-demo-fixture-'));
  temporaryDirectories.push(directory);
  await fs.cp(demoRoot, directory, { recursive: true });
  await fs.copyFile(
    path.join(directory, 'golden', 'parse-report.ts'),
    path.join(directory, 'src', 'parse-report.ts'),
  );
  await fs.copyFile(
    path.join(directory, 'golden', 'parse-report.test.ts'),
    path.join(directory, 'test', 'parse-report.test.ts'),
  );
  return directory;
}

afterEach(async () => {
  resetDemo();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('demo parser fixture', () => {
  it('resets to a failing TypeScript test that is fixed by a one-line source patch', async () => {
    const root = await copyDemo();
    const sourcePath = path.join(root, 'src', 'parse-report.ts');
    const failing = runDemoTests(root);
    expect(failing.status).not.toBe(0);
    expect(`${failing.stdout}\n${failing.stderr}`).toMatch(/# fail\s+1/u);

    const source = await fs.readFile(sourcePath, 'utf8');
    expect(source).toContain('total: passed,');
    await fs.writeFile(
      sourcePath,
      source.replace('    total: passed,', '    total: passed + failed,'),
      'utf8',
    );

    const passing = runDemoTests(root);
    expect(passing.status).toBe(0);
    expect(`${passing.stdout}\n${passing.stderr}`).toMatch(/# fail\s+0/u);
  });

  it('restores golden tests even after they are edited', async () => {
    await fs.writeFile(testPath, 'throw new Error("tests must not be modified");\n', 'utf8');
    resetDemo();
    const restored = await fs.readFile(testPath, 'utf8');
    expect(restored).toContain('parseReport counts failed tests in the total');
    expect(restored).not.toContain('tests must not be modified');
  });

  it('documents that the agent must not modify tests', async () => {
    const prompt = await fs.readFile(path.join(demoRoot, 'prompt.txt'), 'utf8');
    const agents = await fs.readFile(path.join(demoRoot, 'AGENTS.md'), 'utf8');
    const guide = await fs.readFile(path.join(repoRoot, 'docs', 'demo.md'), 'utf8');
    expect(prompt).toMatch(/Do not modify any test files/u);
    expect(prompt).toContain('apply_patch');
    expect(prompt).toContain('npm test');
    expect(agents).toMatch(/Do not modify `test\//u);
    expect(guide).toContain('node scripts/demo-reset.mjs');
    expect(guide).toContain('备用录制方案');
  });
});
