import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfigFile } from '../../../src/config/config-file.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('loadConfigFile', () => {
  it('returns parsed values for echo.config.json', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'echo.config.json'),
      JSON.stringify({ model: 'file-model', safetyMode: 'safe' }),
      'utf8',
    );

    const result = await loadConfigFile(dir);
    expect(result.config).toEqual({ model: 'file-model', safetyMode: 'safe' });
    expect(result.error).toBeUndefined();
  });

  it('preserves unknown keys so they surface later as config warnings', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, '.echo-config.json'),
      JSON.stringify({ model: 'm', totallyUnknown: 1 }),
      'utf8',
    );

    const result = await loadConfigFile(dir);
    expect(result.config).toEqual({ model: 'm', totallyUnknown: 1 });
  });

  it('returns undefined when no config file exists', async () => {
    const dir = await makeTempDir();
    const result = await loadConfigFile(dir);
    expect(result.config).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('reports invalid JSON without throwing', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'echo.config.json'), '{ not json', 'utf8');

    const result = await loadConfigFile(dir);
    expect(result.config).toBeUndefined();
    expect(result.error).toContain('not valid JSON');
  });

  it('treats an empty file as no configuration', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'echo.config.json'), '   ', 'utf8');

    const result = await loadConfigFile(dir);
    expect(result.config).toBeUndefined();
  });

  it('rejects a non-object root with an error message', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'echo.config.json'), '["nope"]', 'utf8');

    const result = await loadConfigFile(dir);
    expect(result.error).toBeTruthy();
  });

  it('prefers echo.config.json over .echo-config.json', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'echo.config.json'),
      JSON.stringify({ model: 'first' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, '.echo-config.json'),
      JSON.stringify({ model: 'second' }),
      'utf8',
    );

    const result = await loadConfigFile(dir);
    expect(result.config).toEqual({ model: 'first' });
  });

  it('does not read an api key from a config file', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, 'echo.config.json'),
      JSON.stringify({ apiKey: 'should-not-load' }),
      'utf8',
    );

    const result = await loadConfigFile(dir);
    expect(result.config).toEqual({});
  });
});
