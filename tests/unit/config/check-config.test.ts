import { describe, expect, it } from 'vitest';

import { checkConfig } from '../../../src/config/index.js';
import { loadConfig, type ConfigInput } from '../../../src/config/load-config.js';

function buildConfig(input: Partial<ConfigInput> = {}): ReturnType<typeof loadConfig>['config'] {
  return loadConfig({
    env: { ECHO_API_KEY: 'key' },
    ...input,
  }).config;
}

describe('checkConfig', () => {
  it('passes when model and API key are present', () => {
    const result = checkConfig(buildConfig({ env: { ECHO_API_KEY: 'key', ECHO_MODEL: 'm' } }));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('fails when the model name is missing', () => {
    const result = checkConfig(buildConfig());
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Model name'))).toBe(true);
  });

  it('fails when the API key is missing', () => {
    const result = checkConfig(buildConfig({ env: { ECHO_MODEL: 'm' } }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('API key'))).toBe(true);
  });

  it('never exposes the API key value through issues', () => {
    const result = checkConfig(
      buildConfig({ env: { ECHO_API_KEY: 'super-secret', ECHO_MODEL: 'm' } }),
    );
    const text = JSON.stringify(result.issues);
    expect(text).not.toContain('super-secret');
  });

  it('fails when reserved output tokens are not smaller than the budget', () => {
    const config = {
      ...buildConfig({ env: { ECHO_MODEL: 'm' } }),
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
      ...buildConfig({ env: { ECHO_API_KEY: 'key', ECHO_MODEL: 'm' } }),
      baseUrl: 'not-a-url',
    });
    const credentialBearing = checkConfig({
      ...buildConfig({ env: { ECHO_API_KEY: 'key', ECHO_MODEL: 'm' } }),
      baseUrl: 'https://user:password@example.test/v1',
    });

    expect(invalid.ok).toBe(false);
    expect(credentialBearing.ok).toBe(false);
    expect(JSON.stringify(credentialBearing.issues)).not.toContain('password');
  });

  it('fails when an invalid safety mode crosses the runtime boundary', () => {
    const config = {
      ...buildConfig({ env: { ECHO_API_KEY: 'key', ECHO_MODEL: 'm' } }),
      safetyMode: 'unsafe',
    } as unknown as ReturnType<typeof loadConfig>['config'];

    const result = checkConfig(config);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Safety mode'))).toBe(true);
  });
});
