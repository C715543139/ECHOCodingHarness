import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_STEPS,
  DEFAULT_SAFETY_MODE,
  ENV_KEYS,
  loadConfig,
  type ConfigInput,
  type RawConfigValues,
} from '../../../src/config/index.js';

function makeInput(overrides: Partial<ConfigInput> = {}): ConfigInput {
  return {
    env: {},
    ...overrides,
  };
}

function rawConfig(values: Record<string, unknown>): RawConfigValues {
  return values as RawConfigValues;
}

describe('loadConfig', () => {
  it('applies built-in defaults when nothing is configured', () => {
    const { config, warnings } = loadConfig(makeInput());

    expect(warnings).toEqual([]);
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.model).toBe('');
    expect(config.safetyMode).toBe(DEFAULT_SAFETY_MODE);
    expect(config.safetyMode).toBe('balanced');
    expect(config.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(config.apiKeyPresent).toBe(false);
  });

  it('reads base URL, model, and safety mode from environment variables', () => {
    const { config } = loadConfig(
      makeInput({
        env: {
          [ENV_KEYS.baseUrl]: 'https://example.internal/v1',
          [ENV_KEYS.model]: 'test-model',
          [ENV_KEYS.safetyMode]: 'safe',
          [ENV_KEYS.apiKey]: 'secret-value',
        },
      }),
    );

    expect(config.baseUrl).toBe('https://example.internal/v1');
    expect(config.model).toBe('test-model');
    expect(config.safetyMode).toBe('safe');
    expect(config.apiKeyPresent).toBe(true);
  });

  it('detects an API key that is only whitespace', () => {
    const { config } = loadConfig(makeInput({ env: { [ENV_KEYS.apiKey]: '   ' } }));
    expect(config.apiKeyPresent).toBe(false);
  });

  it('resolves values by precedence cli > env > project > user', () => {
    const { config } = loadConfig(
      makeInput({
        env: { [ENV_KEYS.model]: 'env-model', [ENV_KEYS.safetyMode]: 'safe' },
        projectConfig: { model: 'project-model', safetyMode: 'auto' },
        userConfig: { model: 'user-model', safetyMode: 'safe' },
        overrides: { model: 'cli-model' },
      }),
    );

    expect(config.model).toBe('cli-model');
    expect(config.safetyMode).toBe('safe');
  });

  it('falls back to the project config when env and cli are silent', () => {
    const { config } = loadConfig(
      makeInput({
        projectConfig: { model: 'project-model', baseUrl: 'https://project.example/v1' },
        userConfig: { model: 'user-model' },
      }),
    );

    expect(config.model).toBe('project-model');
    expect(config.baseUrl).toBe('https://project.example/v1');
  });

  it('normalizes safety mode case and trims surrounding whitespace', () => {
    const { config } = loadConfig(makeInput({ env: { [ENV_KEYS.safetyMode]: '  AUTO ' } }));
    expect(config.safetyMode).toBe('auto');
  });

  it('rejects an unknown safety mode with a warning and keeps the default', () => {
    const { config, warnings } = loadConfig(makeInput({ env: { [ENV_KEYS.safetyMode]: 'yolo' } }));

    expect(config.safetyMode).toBe('balanced');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.source).toBe('env');
    expect(warnings[0]?.message).toContain('safetyMode');
  });

  it('ignores invalid numeric fields with a warning instead of crashing', () => {
    const { config, warnings } = loadConfig(
      makeInput({ projectConfig: { maxSteps: -3, timeoutMs: 'fast' } }),
    );

    expect(config.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(config.timeoutMs).toBe(120_000);
    const messages = warnings.map((warning) => warning.message);
    expect(messages.some((message) => message.includes('maxSteps'))).toBe(true);
    expect(messages.some((message) => message.includes('timeoutMs'))).toBe(true);
  });

  it('warns about unknown configuration keys from every file source', () => {
    const { warnings } = loadConfig(
      makeInput({
        projectConfig: rawConfig({ model: 'm', typoKey: 1 }),
        userConfig: rawConfig({ otherTypo: true }),
        overrides: rawConfig({ cliTypo: 'x' }),
      }),
    );

    const messages = warnings.map((warning) => warning.message);
    expect(messages.some((message) => message.includes('typoKey'))).toBe(true);
    expect(messages.some((message) => message.includes('otherTypo'))).toBe(true);
    expect(messages.some((message) => message.includes('cliTypo'))).toBe(true);
  });

  it('reports an unknown key preserved by the config file loader', () => {
    const { warnings } = loadConfig(
      makeInput({ projectConfig: { model: 'm', misspelledModel: 'other' } }),
    );

    expect(warnings).toContainEqual({
      source: 'project',
      message:
        'Unknown configuration key "misspelledModel" in project configuration was ignored; check for typos.',
    });
  });

  it('accepts a valid context budget from config files', () => {
    const { config } = loadConfig(
      makeInput({
        projectConfig: { context: { maxApproxTokens: 16_000, reservedOutputTokens: 2_000 } },
      }),
    );

    expect(config.context.maxApproxTokens).toBe(16_000);
    expect(config.context.reservedOutputTokens).toBe(2_000);
  });

  it('warns when a context budget is incomplete', () => {
    const { config, warnings } = loadConfig(
      makeInput({ projectConfig: { context: { maxApproxTokens: 16_000 } } }),
    );

    expect(config.context.maxApproxTokens).toBe(32_000);
    expect(warnings.some((warning) => warning.message.includes('context'))).toBe(true);
  });
});
