import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRuntimeConfig } from '../../../src/config/index.js';
import { CONFIG_ERROR_CODES } from '../../../src/contracts/config.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-runtime-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeConfig(artifactRoot: string, values: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(artifactRoot, 'config', 'echo.config.json'),
    JSON.stringify(values),
    'utf8',
  );
}

describe('loadRuntimeConfig', () => {
  it('loads the artifact-root file even when cwd has a decoy config and env overrides', async () => {
    const artifactRoot = await makeTempDir();
    const cwd = await makeTempDir();
    await writeConfig(artifactRoot, {
      baseUrl: 'https://artifact.example/v1',
      model: 'artifact-model',
      modelCatalog: { source: 'discover' },
      safetyMode: 'safe',
    });
    await fs.writeFile(
      path.join(cwd, 'echo.config.json'),
      JSON.stringify({
        baseUrl: 'https://cwd.example/v1',
        model: 'cwd-model',
        modelCatalog: { source: 'discover' },
      }),
      'utf8',
    );

    const original = process.cwd();
    try {
      process.chdir(cwd);
      const loaded = await loadRuntimeConfig({
        artifactRoot,
        env: {
          ECHO_API_KEY: 'key',
          ECHO_BASE_URL: 'https://env.example/v1',
          ECHO_MODEL: 'env-model',
          ECHO_SAFETY_MODE: 'auto',
        },
      });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        return;
      }
      expect(loaded.config.model).toBe('artifact-model');
      expect(loaded.config.baseUrl).toBe('https://artifact.example/v1');
      expect(loaded.config.safetyMode).toBe('safe');
    } finally {
      process.chdir(original);
    }
  });

  it('returns CONFIG_MISSING without creating a file', async () => {
    const artifactRoot = await makeTempDir();
    const loaded = await loadRuntimeConfig({
      artifactRoot,
      env: { ECHO_API_KEY: 'key' },
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      return;
    }
    expect(loaded.issues[0]?.code).toBe(CONFIG_ERROR_CODES.missingFile);
    await expect(
      fs.stat(path.join(artifactRoot, 'config', 'echo.config.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a relative artifact-root instead of using process.cwd()', async () => {
    const loaded = await loadRuntimeConfig({ artifactRoot: 'relative-root' });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      return;
    }
    expect(loaded.issues[0]?.code).toBe(CONFIG_ERROR_CODES.artifactRoot);
  });
});
