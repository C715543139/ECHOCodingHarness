import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearProviderConfigDiscoverCache,
  createProviderConfigService,
  normalizeConfigWriteLockKey,
  persistentConfigPath,
  type ProviderConfigService,
} from '../../../src/config/index.js';
import { CONFIG_ERROR_CODES } from '../../../src/contracts/config.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-config-service-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearProviderConfigDiscoverCache();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const persistentSample = {
  baseUrl: 'https://provider.example/v1',
  model: 'example-model',
  modelCatalog: { source: 'discover' as const },
  safetyMode: 'safe' as const,
  maxSteps: 12,
  timeoutMs: 90_000,
  maxOutputChars: 12_000,
  requestTimeoutMs: 180_000,
  context: { maxApproxTokens: 128_000, reservedOutputTokens: 8_000 },
};

const settingsDraft = {
  baseUrl: 'https://other.example/v1',
  catalog: { source: 'manual' as const, models: ['kept-model', 'extra-model'] },
  defaultModel: 'kept-model',
};

function service(
  artifactRoot: string,
  options: {
    readonly env?: Record<string, string | undefined>;
    readonly listModelIds?: (input: {
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<readonly string[]>;
    readonly now?: () => Date;
  } = {},
): ProviderConfigService {
  return createProviderConfigService({
    artifactRoot,
    env: options.env ?? { ECHO_API_KEY: 'test-secret-key' },
    ...(options.listModelIds === undefined ? {} : { listModelIds: options.listModelIds }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

async function writeRaw(artifactRoot: string, value: unknown | string): Promise<string> {
  const dest = persistentConfigPath(artifactRoot);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(dest, text, 'utf8');
  return dest;
}

function expectNoSecretsOrAbsolutePaths(
  value: unknown,
  artifactRoot: string,
  secret = 'super-secret-key',
): void {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(new RegExp(secret, 'u'));
  expect(text).not.toContain(artifactRoot);
  expect(text).not.toContain(os.homedir());
  expect(text).not.toMatch(/[A-Za-z]:\\Users\\/u);
}

describe('normalizeConfigWriteLockKey', () => {
  it('shares one win32 lock across path case variants without depending on the current OS', () => {
    expect(normalizeConfigWriteLockKey('C:\\Echo\\Config\\echo.config.json', 'win32')).toBe(
      normalizeConfigWriteLockKey('c:\\echo\\config\\echo.config.json', 'win32'),
    );
    expect(normalizeConfigWriteLockKey('/tmp/Echo/config/echo.config.json', 'linux')).not.toBe(
      normalizeConfigWriteLockKey('/tmp/echo/config/echo.config.json', 'linux'),
    );
  });
});

describe('createProviderConfigService', () => {
  it('rejects a relative artifact-root instead of falling back to process.cwd()', async () => {
    const created = createProviderConfigService({ artifactRoot: 'relative-root' });
    const read = await created.read();
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.issues[0]?.code).toBe(CONFIG_ERROR_CODES.artifactRoot);
    expect(read.issues[0]?.message).toContain('absolute path');
  });

  it('reads the artifact-root file and reports ECHO_API_KEY without exposing the value', async () => {
    const artifactRoot = await makeTempDir();
    const cwd = await makeTempDir();
    await writeRaw(artifactRoot, persistentSample);
    await writeRaw(cwd, { ...persistentSample, model: 'cwd-model' });

    const original = process.cwd();
    try {
      process.chdir(cwd);
      const result = await service(artifactRoot, {
        env: {
          ECHO_API_KEY: 'super-secret-key',
          ECHO_BASE_URL: 'https://env.example/v1',
          ECHO_MODEL: 'env-model',
        },
      }).read();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.persistent.model).toBe('example-model');
      expect(result.value.persistent.baseUrl).toBe('https://provider.example/v1');
      expect(result.value.apiKeyConfigured).toBe(true);
      expectNoSecretsOrAbsolutePaths(result.value, artifactRoot);
      expect(JSON.stringify(result.value)).not.toMatch(/ECHO_BASE_URL|env-model/u);
    } finally {
      process.chdir(original);
    }
  });

  it('treats a missing file as CONFIG_MISSING and does not create one', async () => {
    const artifactRoot = await makeTempDir();
    const result = await service(artifactRoot).read();
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues[0]?.code).toBe(CONFIG_ERROR_CODES.missingFile);
    await expect(fs.stat(persistentConfigPath(artifactRoot))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('validates Provider settings and persistent config through separate methods', () => {
    const created = service('C:\\echo-artifact-root');
    const settings = created.validateProviderSettings({
      baseUrl: 'https://provider.example/v1',
      catalog: { source: 'discover' },
      defaultModel: 'example-model',
    });
    const persistent = created.validatePersistentConfig(persistentSample);
    expect(settings.ok).toBe(true);
    expect(persistent.ok).toBe(true);
    if (!settings.ok || !persistent.ok) {
      return;
    }
    expect(settings.value.defaultModel).toBe('example-model');
    expect(persistent.value.safetyMode).toBe('safe');
  });

  it('rejects unknown fields, credentials, secrets, and tokens on Provider settings', async () => {
    const artifactRoot = await makeTempDir();
    await writeRaw(artifactRoot, persistentSample);
    const dest = persistentConfigPath(artifactRoot);
    const before = await fs.readFile(dest, 'utf8');
    const created = service(artifactRoot, { env: { ECHO_API_KEY: 'super-secret-key' } });

    const withKey = await created.saveProviderSettings({
      ...settingsDraft,
      apiKey: 'super-secret-key',
    });
    const withToken = await created.saveProviderSettings({
      ...settingsDraft,
      accessToken: 'super-secret-key',
    });
    const unknown = await created.saveProviderSettings({
      ...settingsDraft,
      totallyUnknown: true,
    });

    expect(withKey.ok).toBe(false);
    expect(withToken.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (withKey.ok || withToken.ok || unknown.ok) {
      return;
    }
    expect(withKey.issues[0]?.code).toBe(CONFIG_ERROR_CODES.credentialForbidden);
    expect(withToken.issues[0]?.code).toBe(CONFIG_ERROR_CODES.credentialForbidden);
    expect(unknown.issues[0]?.code).toBe(CONFIG_ERROR_CODES.unknownKey);
    expect(await fs.readFile(dest, 'utf8')).toBe(before);
    expectNoSecretsOrAbsolutePaths([withKey, withToken, unknown], artifactRoot);
  });

  it('creates a legal file with balanced safety when none exists and never writes a key', async () => {
    const artifactRoot = await makeTempDir();
    const result = await service(artifactRoot, {
      env: { ECHO_API_KEY: 'super-secret-key' },
    }).saveProviderSettings({
      baseUrl: 'https://provider.example/v1',
      catalog: { source: 'discover' },
      defaultModel: 'example-model',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const text = await fs.readFile(persistentConfigPath(artifactRoot), 'utf8');
    expect(JSON.parse(text)).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'example-model',
      modelCatalog: { source: 'discover' },
      safetyMode: 'balanced',
    });
    expect(text).not.toMatch(/apiKey|super-secret-key|ECHO_API_KEY/iu);
    expectNoSecretsOrAbsolutePaths(result.value, artifactRoot);
  });

  it('merges only Provider fields and keeps every other persistent field', async () => {
    const artifactRoot = await makeTempDir();
    await writeRaw(artifactRoot, persistentSample);
    const saved = await service(artifactRoot).saveProviderSettings(settingsDraft);
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    expect(JSON.parse(await fs.readFile(persistentConfigPath(artifactRoot), 'utf8'))).toEqual({
      baseUrl: 'https://other.example/v1',
      model: 'kept-model',
      modelCatalog: { source: 'manual', models: ['kept-model', 'extra-model'] },
      safetyMode: 'safe',
      maxSteps: 12,
      timeoutMs: 90_000,
      maxOutputChars: 12_000,
      requestTimeoutMs: 180_000,
      context: { maxApproxTokens: 128_000, reservedOutputTokens: 8_000 },
    });
  });

  it('fails closed on damaged JSON and leaves the original bytes unchanged', async () => {
    const artifactRoot = await makeTempDir();
    const dest = await writeRaw(artifactRoot, '{ not json');
    const before = await fs.readFile(dest, 'utf8');
    const result = await service(artifactRoot).saveProviderSettings(settingsDraft);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.code === CONFIG_ERROR_CODES.invalid)).toBe(true);
    expect(await fs.readFile(dest, 'utf8')).toBe(before);
    expectNoSecretsOrAbsolutePaths(result, artifactRoot, 'test-secret-key');
  });

  it('fails closed when the existing file has an unknown key or illegal schema', async () => {
    const artifactRoot = await makeTempDir();
    const dest = await writeRaw(artifactRoot, { ...persistentSample, totallyUnknown: true });
    const before = await fs.readFile(dest, 'utf8');
    const unknown = await service(artifactRoot).saveProviderSettings(settingsDraft);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      return;
    }
    expect(unknown.issues.some((issue) => issue.code === CONFIG_ERROR_CODES.unknownKey)).toBe(true);
    expect(await fs.readFile(dest, 'utf8')).toBe(before);

    const schemaRoot = await makeTempDir();
    const schemaDest = await writeRaw(schemaRoot, {
      baseUrl: 'https://provider.example/v1',
      model: 'legacy-model',
      safetyMode: 'safe',
      maxOutputChars: 12_000,
      context: { maxApproxTokens: 128_000, reservedOutputTokens: 8_000 },
    });
    const schemaBefore = await fs.readFile(schemaDest, 'utf8');
    const schemaInvalid = await service(schemaRoot).saveProviderSettings(settingsDraft);
    expect(schemaInvalid.ok).toBe(false);
    if (schemaInvalid.ok) {
      return;
    }
    expect(
      schemaInvalid.issues.some((issue) => issue.code === CONFIG_ERROR_CODES.invalidCatalog),
    ).toBe(true);
    expect(await fs.readFile(schemaDest, 'utf8')).toBe(schemaBefore);
  });

  it('lets replacePersistentConfig repair a damaged file but rejects an illegal replacement', async () => {
    const artifactRoot = await makeTempDir();
    const dest = await writeRaw(artifactRoot, '{ not json');
    const created = service(artifactRoot, { env: { ECHO_API_KEY: 'super-secret-key' } });

    const repaired = await created.replacePersistentConfig(persistentSample);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) {
      return;
    }
    expect(JSON.parse(await fs.readFile(dest, 'utf8')).model).toBe('example-model');

    const before = await fs.readFile(dest, 'utf8');
    const rejected = await created.replacePersistentConfig({
      ...persistentSample,
      apiKey: 'super-secret-key',
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) {
      return;
    }
    expect(rejected.issues[0]?.code).toBe(CONFIG_ERROR_CODES.credentialForbidden);
    expect(await fs.readFile(dest, 'utf8')).toBe(before);
    expectNoSecretsOrAbsolutePaths(rejected, artifactRoot);
  });

  it('serializes concurrent saves so both complete and the file stays a full snapshot', async () => {
    const artifactRoot = await makeTempDir();
    await writeRaw(artifactRoot, persistentSample);
    const created = service(artifactRoot);
    const results = await Promise.all([
      created.saveProviderSettings({
        baseUrl: 'https://provider.example/v1',
        catalog: { source: 'discover' },
        defaultModel: 'model-a',
      }),
      created.saveProviderSettings({
        baseUrl: 'https://provider.example/v1',
        catalog: { source: 'discover' },
        defaultModel: 'model-b',
      }),
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
    const parsed = JSON.parse(await fs.readFile(persistentConfigPath(artifactRoot), 'utf8')) as {
      readonly model: string;
      readonly safetyMode: string;
      readonly maxSteps: number;
    };
    expect(['model-a', 'model-b']).toContain(parsed.model);
    expect(parsed.safetyMode).toBe('safe');
    expect(parsed.maxSteps).toBe(12);
  });

  it('discovers models only on an explicit call and never auto-saves', async () => {
    const artifactRoot = await makeTempDir();
    await writeRaw(artifactRoot, persistentSample);
    const calls: string[] = [];
    const created = service(artifactRoot, {
      env: { ECHO_API_KEY: 'super-secret-key' },
      now: () => new Date('2026-08-30T07:00:00.000Z'),
      listModelIds: async (input) => {
        calls.push(input.baseUrl);
        expect(input.apiKey).toBe('super-secret-key');
        return ['discovered-b', 'discovered-a', 'discovered-b'];
      },
    });

    const discovered = await created.discoverModels('https://provider.example/v1');
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) {
      return;
    }
    expect(discovered.value).toEqual({
      models: ['discovered-b', 'discovered-a'],
      fetchedAt: '2026-08-30T07:00:00.000Z',
    });
    expect(JSON.parse(await fs.readFile(persistentConfigPath(artifactRoot), 'utf8')).model).toBe(
      'example-model',
    );
    const after = await created.read();
    expect(after.ok).toBe(true);
    if (!after.ok) {
      return;
    }
    expect(after.value.cachedModels).toEqual(['discovered-b', 'discovered-a']);
    expect(calls).toEqual(['https://provider.example/v1']);
  });

  it('does not discover when ECHO_API_KEY is missing and does not write a file', async () => {
    const artifactRoot = await makeTempDir();
    let called = false;
    const result = await service(artifactRoot, {
      env: {},
      listModelIds: async () => {
        called = true;
        return ['should-not-run'];
      },
    }).discoverModels('https://provider.example/v1');
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe(CONFIG_ERROR_CODES.missingApiKey);
    await expect(fs.stat(persistentConfigPath(artifactRoot))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('redacts secrets, home paths, and absolute artifact paths from service errors', async () => {
    const artifactRoot = await makeTempDir();
    const dest = await writeRaw(artifactRoot, '{ not json');
    const read = await service(artifactRoot, { env: { ECHO_API_KEY: 'super-secret-key' } }).read();
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expectNoSecretsOrAbsolutePaths(read.issues, artifactRoot);
    expect(read.issues.some((issue) => issue.path === 'config/echo.config.json')).toBe(true);

    const discovered = await service(artifactRoot, {
      env: { ECHO_API_KEY: 'super-secret-key' },
      listModelIds: async () => {
        throw new Error(
          `401 Authorization: Bearer super-secret-key at ${path.join(os.homedir(), 'secret-store')} ${dest}`,
        );
      },
    }).discoverModels('https://provider.example/v1');
    expect(discovered.ok).toBe(false);
    if (discovered.ok) {
      return;
    }
    expect(discovered.error.cause).toBeUndefined();
    expectNoSecretsOrAbsolutePaths(discovered.error, artifactRoot);
    expect(discovered.error.message).not.toContain(dest);
  });
});
