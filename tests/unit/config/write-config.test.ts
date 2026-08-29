import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  persistentConfigPath,
  writePersistentConfigFile,
  type ConfigFileWriter,
} from '../../../src/config/index.js';
import type { EchoPersistentConfig } from '../../../src/contracts/config.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-write-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const sample: EchoPersistentConfig = {
  baseUrl: 'https://provider.example/v1',
  model: 'example-model',
  modelCatalog: { source: 'discover' },
  safetyMode: 'balanced',
};

describe('writePersistentConfigFile', () => {
  it('writes JSON without secrets and creates the config directory', async () => {
    const artifactRoot = await makeTempDir();
    const written = await writePersistentConfigFile(artifactRoot, sample);
    const text = await fs.readFile(written.path, 'utf8');
    expect(written.path).toBe(persistentConfigPath(artifactRoot));
    expect(JSON.parse(text)).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'example-model',
      modelCatalog: { source: 'discover' },
      safetyMode: 'balanced',
    });
    expect(text).not.toMatch(/apiKey|ECHO_API_KEY|secret/iu);
  });

  it('keeps the previous file when the atomic replace fails', async () => {
    const artifactRoot = await makeTempDir();
    await writePersistentConfigFile(artifactRoot, sample);
    const dest = persistentConfigPath(artifactRoot);
    const previous = await fs.readFile(dest, 'utf8');

    const writer: ConfigFileWriter = {
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      rename: async () => {
        throw Object.assign(new Error('replace failed'), { code: 'EPERM' });
      },
      rm: async () => undefined,
    };

    await expect(
      writePersistentConfigFile(artifactRoot, { ...sample, model: 'replacement-model' }, writer),
    ).rejects.toThrow(/replace failed/u);

    expect(await fs.readFile(dest, 'utf8')).toBe(previous);
    expect(JSON.parse(previous).model).toBe('example-model');
  });
});
