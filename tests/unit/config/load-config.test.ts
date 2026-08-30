import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_APPROX_TOKENS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_STEPS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_SAFETY_MODE,
  ENV_KEYS,
  loadConfig,
  type ConfigInput,
} from '../../../src/config/index.js';
import { CONFIG_ERROR_CODES } from '../../../src/contracts/config.js';

const fileConfig = {
  baseUrl: 'https://provider.example/v1',
  model: 'file-model',
  modelCatalog: { source: 'discover' as const },
  safetyMode: 'safe' as const,
};

function makeInput(overrides: Partial<ConfigInput> = {}): ConfigInput {
  return {
    env: {},
    fileConfig,
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('fails closed when the persistent file is missing', () => {
    const result = loadConfig({ env: {} });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues[0]?.code).toBe(CONFIG_ERROR_CODES.missingFile);
    expect(result.issues[0]?.message).toContain('echo-harness config');
  });

  it('merges CLI explicit args over the persistent file and ignores removed env sources', () => {
    const result = loadConfig(
      makeInput({
        env: {
          ECHO_BASE_URL: 'https://env.example/v1',
          ECHO_MODEL: 'env-model',
          ECHO_SAFETY_MODE: 'auto',
          [ENV_KEYS.apiKey]: 'secret-value',
        },
        overrides: { model: 'cli-model', safetyMode: 'balanced' },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.model).toBe('cli-model');
    expect(result.config.baseUrl).toBe('https://provider.example/v1');
    expect(result.config.safetyMode).toBe('balanced');
    expect(result.config.apiKeyPresent).toBe(true);
  });

  it('does not treat built-in field defaults as a configuration source', () => {
    const result = loadConfig(
      makeInput({
        fileConfig: {
          baseUrl: 'https://provider.example/v1',
          model: 'file-model',
          modelCatalog: { source: 'discover' },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.safetyMode).toBe(DEFAULT_SAFETY_MODE);
    expect(result.config.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(result.config.maxOutputChars).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(result.config.context.maxApproxTokens).toBe(DEFAULT_MAX_APPROX_TOKENS);
    expect(result.config.context.reservedOutputTokens).toBe(DEFAULT_RESERVED_OUTPUT_TOKENS);
    expect(DEFAULT_MAX_APPROX_TOKENS).toBe(256_000);
    expect(DEFAULT_RESERVED_OUTPUT_TOKENS).toBe(16_000);
    expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(40_000);
  });

  it('detects an API key that is only whitespace', () => {
    const result = loadConfig(makeInput({ env: { [ENV_KEYS.apiKey]: '   ' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.apiKeyPresent).toBe(false);
  });

  it('fails closed on invalid numeric fields instead of ignoring them', () => {
    const result = loadConfig(
      makeInput({
        fileConfig: { ...fileConfig, maxSteps: -3 },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.path === 'maxSteps')).toBe(true);
  });

  it('accepts a valid context budget from the persistent file', () => {
    const result = loadConfig(
      makeInput({
        fileConfig: {
          ...fileConfig,
          context: { maxApproxTokens: 16_000, reservedOutputTokens: 2_000 },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.context.maxApproxTokens).toBe(16_000);
    expect(result.config.context.reservedOutputTokens).toBe(2_000);
  });
});
