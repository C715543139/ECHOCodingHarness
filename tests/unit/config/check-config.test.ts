import { describe, expect, it } from 'vitest';

import { checkConfig, loadConfig, type ConfigInput } from '../../../src/config/index.js';

const fileConfig = {
  baseUrl: 'https://provider.example/v1',
  model: 'example-model',
  modelCatalog: { source: 'discover' as const },
};

function buildConfig(input: Partial<ConfigInput> = {}) {
  const loaded = loadConfig({
    env: { ECHO_API_KEY: 'key' },
    fileConfig,
    ...input,
  });
  if (!loaded.ok) {
    throw new Error(loaded.issues.map((issue) => issue.message).join('; '));
  }
  return loaded.config;
}

describe('checkConfig', () => {
  it('passes when model and API key are present', () => {
    const result = checkConfig(buildConfig());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('fails when the API key is missing', () => {
    const result = checkConfig(buildConfig({ env: {} }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('ECHO_API_KEY'))).toBe(true);
  });

  it('never exposes the API key value through issues', () => {
    const result = checkConfig(buildConfig({ env: { ECHO_API_KEY: 'super-secret' } }));
    const text = JSON.stringify(result.issues);
    expect(text).not.toContain('super-secret');
  });

  it('fails when reserved output tokens are not smaller than the budget', () => {
    const config = {
      ...buildConfig(),
      context: { maxApproxTokens: 4_000, reservedOutputTokens: 4_000 },
    };
    const result = checkConfig(config);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('reservedOutputTokens'))).toBe(
      true,
    );
  });

  it('fails for an invalid or credential-bearing provider URL', () => {
    const invalid = checkConfig({
      ...buildConfig(),
      baseUrl: 'not-a-url',
    });
    const credentialBearing = checkConfig({
      ...buildConfig(),
      baseUrl: 'https://user:password@example.test/v1',
    });

    expect(invalid.ok).toBe(false);
    expect(credentialBearing.ok).toBe(false);
    expect(JSON.stringify(credentialBearing.issues)).not.toContain('password');
  });

  it('fails when an invalid safety mode crosses the runtime boundary', () => {
    const config = {
      ...buildConfig(),
      safetyMode: 'unsafe',
    } as unknown as ReturnType<typeof buildConfig>;

    const result = checkConfig(config);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Safety mode'))).toBe(true);
  });
});
