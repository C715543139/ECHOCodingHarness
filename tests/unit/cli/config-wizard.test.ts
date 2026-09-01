import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runConfigWizard, type ConfigWizardIo } from '../../../src/cli/config-wizard.js';
import { persistentConfigPath } from '../../../src/config/index.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-wizard-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function scriptedIo(
  answers: string[],
  abortAfter?: number,
): {
  io: ConfigWizardIo;
  output: () => string;
} {
  const remaining = [...answers];
  let text = '';
  let prompts = 0;
  return {
    io: {
      write: (chunk) => {
        text += chunk;
      },
      prompt: async (message) => {
        text += message;
        prompts += 1;
        if (abortAfter !== undefined && prompts > abortAfter) {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }
        const next = remaining.shift();
        if (next === undefined) {
          throw new Error(`unexpected prompt: ${message}`);
        }
        return next;
      },
    },
    output: () => text,
  };
}

describe('runConfigWizard', () => {
  it('writes a discover catalog after confirmation and never stores a secret', async () => {
    const artifactRoot = await makeTempDir();
    const scripted = scriptedIo([
      'https://provider.example/v1',
      '1',
      'example-model',
      'balanced',
      'y',
    ]);

    const outcome = await runConfigWizard({ artifactRoot, io: scripted.io });
    const dest = persistentConfigPath(artifactRoot);
    const written = JSON.parse(await fs.readFile(dest, 'utf8')) as Record<string, unknown>;

    expect(outcome.exitCode).toBe(0);
    expect(outcome.configPath).toBe(dest);
    expect(written).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'example-model',
      modelCatalog: { source: 'discover' },
      safetyMode: 'balanced',
      maxOutputChars: 80_000,
      context: { maxApproxTokens: 256_000, reservedOutputTokens: 16_000 },
    });
    expect(JSON.stringify(written)).not.toMatch(/apiKey|secret/iu);
    expect(scripted.output()).toContain('ECHO_API_KEY');
    expect(scripted.output()).toContain('GET /models');
  });

  it('does not create a file when the user cancels before writing', async () => {
    const artifactRoot = await makeTempDir();
    const scripted = scriptedIo([
      'https://provider.example/v1',
      'discover',
      'example-model',
      'safe',
      'n',
    ]);

    const outcome = await runConfigWizard({ artifactRoot, io: scripted.io });
    await expect(fs.stat(persistentConfigPath(artifactRoot))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(outcome.exitCode).toBe(0);
    expect(scripted.output()).toContain('not changed');
  });

  it('does not write a partial file when the wizard is aborted', async () => {
    const artifactRoot = await makeTempDir();
    const scripted = scriptedIo(['https://provider.example/v1'], 1);

    const outcome = await runConfigWizard({ artifactRoot, io: scripted.io });
    await expect(fs.stat(persistentConfigPath(artifactRoot))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(outcome.exitCode).toBe(130);
    expect(scripted.output()).toContain('No configuration file was written');
  });

  it('repairs a damaged file through explicit full replacement, not Provider merge', async () => {
    const artifactRoot = await makeTempDir();
    const dest = persistentConfigPath(artifactRoot);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, '{ not json', 'utf8');
    const scripted = scriptedIo([
      'https://provider.example/v1',
      '1',
      'repaired-model',
      'safe',
      'y',
    ]);

    const outcome = await runConfigWizard({ artifactRoot, io: scripted.io });
    expect(outcome.exitCode).toBe(0);
    expect(JSON.parse(await fs.readFile(dest, 'utf8'))).toMatchObject({
      baseUrl: 'https://provider.example/v1',
      model: 'repaired-model',
      modelCatalog: { source: 'discover' },
      safetyMode: 'safe',
    });
  });

  it('keeps an existing file when a later abort happens', async () => {
    const artifactRoot = await makeTempDir();
    await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
    const dest = persistentConfigPath(artifactRoot);
    await fs.writeFile(
      dest,
      JSON.stringify({
        baseUrl: 'https://provider.example/v1',
        model: 'kept-model',
        modelCatalog: { source: 'discover' },
        safetyMode: 'safe',
      }),
      'utf8',
    );
    const previous = await fs.readFile(dest, 'utf8');
    const scripted = scriptedIo(['https://other.example/v1', '2', 'new-model'], 2);

    const outcome = await runConfigWizard({ artifactRoot, io: scripted.io });
    expect(outcome.exitCode).toBe(130);
    expect(await fs.readFile(dest, 'utf8')).toBe(previous);
  });
});
