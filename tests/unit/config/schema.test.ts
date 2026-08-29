import { describe, expect, it } from 'vitest';

import { CONFIG_ERROR_CODES } from '../../../src/contracts/config.js';
import { parsePersistentConfig, serializePersistentConfig } from '../../../src/config/index.js';

const validDiscover = {
  baseUrl: 'https://provider.example/v1',
  model: 'example-model',
  modelCatalog: { source: 'discover' },
  safetyMode: 'balanced',
};

describe('parsePersistentConfig', () => {
  it('accepts a discover catalog without persisting a model list', () => {
    const parsed = parsePersistentConfig(validDiscover);
    expect(parsed).toEqual({
      config: {
        baseUrl: 'https://provider.example/v1',
        model: 'example-model',
        modelCatalog: { source: 'discover' },
        safetyMode: 'balanced',
      },
    });
  });

  it('requires unique non-empty manual catalog IDs and default membership', () => {
    const parsed = parsePersistentConfig({
      ...validDiscover,
      model: 'model-a',
      modelCatalog: { source: 'manual', models: ['model-a', 'model-b'] },
    });
    expect('config' in parsed && parsed.config.modelCatalog).toEqual({
      source: 'manual',
      models: ['model-a', 'model-b'],
    });

    const missingDefault = parsePersistentConfig({
      ...validDiscover,
      model: 'missing',
      modelCatalog: { source: 'manual', models: ['model-a'] },
    });
    expect('issues' in missingDefault && missingDefault.issues[0]?.code).toBe(
      CONFIG_ERROR_CODES.modelNotInCatalog,
    );
  });

  it('rejects unknown keys, credentials, and embedded URL userinfo', () => {
    const unknown = parsePersistentConfig({ ...validDiscover, typoKey: 1 });
    expect('issues' in unknown && unknown.issues[0]?.code).toBe(CONFIG_ERROR_CODES.unknownKey);

    const secret = parsePersistentConfig({ ...validDiscover, apiKey: 'should-not-load' });
    expect('issues' in secret && secret.issues[0]?.code).toBe(
      CONFIG_ERROR_CODES.credentialForbidden,
    );
    expect(JSON.stringify(secret)).not.toContain('should-not-load');

    const embedded = parsePersistentConfig({
      ...validDiscover,
      baseUrl: 'https://user:password@example.test/v1',
    });
    expect('issues' in embedded && embedded.issues[0]?.code).toBe(
      CONFIG_ERROR_CODES.embeddedCredentials,
    );
    expect(JSON.stringify(embedded)).not.toContain('password');
  });

  it('rejects a discover catalog that persists models', () => {
    const parsed = parsePersistentConfig({
      ...validDiscover,
      modelCatalog: { source: 'discover', models: ['hidden'] },
    });
    expect('issues' in parsed && parsed.issues[0]?.code).toBe(CONFIG_ERROR_CODES.invalidCatalog);
  });

  it('serializes discover catalogs without a models array', () => {
    const parsed = parsePersistentConfig(validDiscover);
    expect('config' in parsed).toBe(true);
    if (!('config' in parsed)) {
      return;
    }
    expect(serializePersistentConfig(parsed.config)).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'example-model',
      modelCatalog: { source: 'discover' },
      safetyMode: 'balanced',
    });
  });
});
