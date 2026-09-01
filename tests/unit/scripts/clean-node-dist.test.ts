import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/clean-node-dist.mjs', import.meta.url));

describe('clean-node-dist', () => {
  it('removes Node outputs and preserves persistent config plus dist/web', async () => {
    const distRoot = await mkdtemp(path.join(tmpdir(), 'echo-clean-dist-'));
    await mkdir(path.join(distRoot, 'config'), { recursive: true });
    await mkdir(path.join(distRoot, 'web', 'assets'), { recursive: true });
    await writeFile(path.join(distRoot, 'config', 'echo.config.json'), '{"model":"demo"}\n');
    await writeFile(path.join(distRoot, 'web', 'index.html'), '<!doctype html><title>echo</title>');
    await writeFile(path.join(distRoot, 'cli.js'), 'export {}\n');
    await writeFile(path.join(distRoot, 'index.js'), 'export {}\n');

    execFileSync(process.execPath, [SCRIPT, distRoot], { windowsHide: true });

    await expect(readFile(path.join(distRoot, 'web', 'index.html'), 'utf8')).resolves.toContain(
      'echo',
    );
    await expect(
      readFile(path.join(distRoot, 'config', 'echo.config.json'), 'utf8'),
    ).resolves.toContain('demo');
    await expect(readFile(path.join(distRoot, 'cli.js'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(path.join(distRoot, 'index.js'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
