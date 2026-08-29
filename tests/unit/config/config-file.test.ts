import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readPersistentConfigFile } from '../../../src/config/index.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('readPersistentConfigFile', () => {
  it('reads only <artifact-root>/config/echo.config.json', async () => {
    const artifactRoot = await makeTempDir();
    const workspace = await makeTempDir();
    await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(artifactRoot, 'config', 'echo.config.json'),
      JSON.stringify({ model: 'artifact-model' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(workspace, 'echo.config.json'),
      JSON.stringify({ model: 'cwd-model' }),
      'utf8',
    );
    await fs.mkdir(path.join(workspace, '.echo', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, '.echo', 'config', 'echo.config.json'),
      JSON.stringify({ model: 'workspace-echo-model' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(artifactRoot, '.echo-config.json'),
      JSON.stringify({ model: 'legacy-model' }),
      'utf8',
    );

    const result = await readPersistentConfigFile(artifactRoot);
    expect(result).toEqual({
      status: 'loaded',
      raw: { model: 'artifact-model' },
    });
  });

  it('returns missing when the persistent file does not exist', async () => {
    const artifactRoot = await makeTempDir();
    const result = await readPersistentConfigFile(artifactRoot);
    expect(result).toEqual({ status: 'missing' });
  });

  it('reports invalid JSON without throwing', async () => {
    const artifactRoot = await makeTempDir();
    await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(artifactRoot, 'config', 'echo.config.json'), '{ not json', 'utf8');

    const result = await readPersistentConfigFile(artifactRoot);
    expect(result.status).toBe('error');
    if (result.status !== 'error') {
      return;
    }
    expect(result.issue.message).toContain('not valid JSON');
  });

  it('treats an empty file as invalid configuration', async () => {
    const artifactRoot = await makeTempDir();
    await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(artifactRoot, 'config', 'echo.config.json'), '   ', 'utf8');

    const result = await readPersistentConfigFile(artifactRoot);
    expect(result.status).toBe('error');
  });

  it('preserves unknown keys and credentials so schema validation can fail closed', async () => {
    const artifactRoot = await makeTempDir();
    await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(artifactRoot, 'config', 'echo.config.json'),
      JSON.stringify({ model: 'm', apiKey: 'placeholder', totallyUnknown: 1 }),
      'utf8',
    );

    const result = await readPersistentConfigFile(artifactRoot);
    expect(result).toEqual({
      status: 'loaded',
      raw: { model: 'm', apiKey: 'placeholder', totallyUnknown: 1 },
    });
  });
});
