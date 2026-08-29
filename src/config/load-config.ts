import {
  CONFIG_ERROR_CODES,
  P1_CONFIG_RELATIVE_PATH,
  type ConfigIssue,
  type EchoPersistentConfig,
  type ModelCatalogConfig,
} from '../contracts/config.js';
import type { SafetyMode } from '../contracts/safety.js';

import { inspectProviderUrl, parsePersistentConfig, SAFETY_MODES } from './schema.js';

export const ENV_KEYS = {
  apiKey: 'ECHO_API_KEY',
} as const;

export const DEFAULT_SAFETY_MODE: SafetyMode = 'balanced';
export const DEFAULT_MAX_STEPS = 24;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
export const DEFAULT_MAX_APPROX_TOKENS = 32_000;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export interface ContextConfig {
  readonly maxApproxTokens: number;
  readonly reservedOutputTokens: number;
}

export interface EchoConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly modelCatalog: ModelCatalogConfig;
  readonly safetyMode: SafetyMode;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly requestTimeoutMs: number;
  readonly context: ContextConfig;
  readonly apiKeyPresent: boolean;
}

export type ConfigSource = 'cli' | 'config';

export interface RawConfigValues {
  readonly [key: string]: unknown;
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly safetyMode?: unknown;
  readonly maxSteps?: unknown;
  readonly timeoutMs?: unknown;
  readonly maxOutputChars?: unknown;
  readonly requestTimeoutMs?: unknown;
  readonly context?: unknown;
}

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: EchoConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export interface ConfigInput {
  readonly env?: Record<string, string | undefined>;
  readonly fileConfig?: unknown;
  readonly overrides?: RawConfigValues;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function apiKeyPresent(env: Record<string, string | undefined>): boolean {
  const apiKey = env[ENV_KEYS.apiKey];
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

function parseCliOverrides(
  overrides: RawConfigValues | undefined,
): ConfigIssue[] | RawConfigValues {
  if (overrides === undefined) {
    return {};
  }
  const issues: ConfigIssue[] = [];
  const values: Record<string, unknown> = {};

  if (overrides.baseUrl !== undefined) {
    const inspected = inspectProviderUrl(overrides.baseUrl);
    if ('code' in inspected) {
      issues.push(inspected);
    } else {
      values['baseUrl'] = inspected.href;
    }
  }
  if (overrides.model !== undefined) {
    const model = asNonEmptyString(overrides.model);
    if (model === undefined) {
      issues.push({
        code: CONFIG_ERROR_CODES.missingModel,
        message: 'Model name is missing. Run echo-harness config or pass --model.',
        path: 'model',
      });
    } else {
      values['model'] = model;
    }
  }
  if (overrides.safetyMode !== undefined) {
    const text = asNonEmptyString(overrides.safetyMode);
    const normalized = text?.toLowerCase();
    if (normalized === undefined || !(SAFETY_MODES as readonly string[]).includes(normalized)) {
      issues.push({
        code: CONFIG_ERROR_CODES.invalid,
        message: `safetyMode must be one of: ${SAFETY_MODES.join(', ')}.`,
        path: 'safetyMode',
      });
    } else {
      values['safetyMode'] = normalized;
    }
  }
  if (overrides.maxSteps !== undefined) {
    const parsed = asPositiveInt(overrides.maxSteps);
    if (parsed === undefined) {
      issues.push({
        code: CONFIG_ERROR_CODES.invalid,
        message: 'maxSteps must be a positive integer.',
        path: 'maxSteps',
      });
    } else {
      values['maxSteps'] = parsed;
    }
  }

  return issues.length > 0 ? issues : values;
}

function applyDefaults(
  persistent: EchoPersistentConfig,
  overrides: RawConfigValues,
  present: boolean,
): EchoConfig {
  return {
    baseUrl: asNonEmptyString(overrides.baseUrl) ?? persistent.baseUrl,
    model: asNonEmptyString(overrides.model) ?? persistent.model,
    modelCatalog: persistent.modelCatalog,
    safetyMode:
      (asNonEmptyString(overrides.safetyMode)?.toLowerCase() as SafetyMode | undefined) ??
      persistent.safetyMode ??
      DEFAULT_SAFETY_MODE,
    maxSteps: asPositiveInt(overrides.maxSteps) ?? persistent.maxSteps ?? DEFAULT_MAX_STEPS,
    timeoutMs: persistent.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: persistent.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    requestTimeoutMs: persistent.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    context: {
      maxApproxTokens: persistent.context?.maxApproxTokens ?? DEFAULT_MAX_APPROX_TOKENS,
      reservedOutputTokens:
        persistent.context?.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
    },
    apiKeyPresent: present,
  };
}

export function missingConfigIssues(configPath = P1_CONFIG_RELATIVE_PATH): readonly ConfigIssue[] {
  return [
    {
      code: CONFIG_ERROR_CODES.missingFile,
      message: `Configuration file is missing (${configPath}). Run echo-harness config.`,
      path: configPath,
    },
  ];
}

export function loadConfig(input: ConfigInput = {}): ConfigLoadResult {
  const env = input.env ?? {};
  if (input.fileConfig === undefined) {
    return { ok: false, issues: missingConfigIssues() };
  }

  const parsed = parsePersistentConfig(input.fileConfig);
  if ('issues' in parsed) {
    return { ok: false, issues: parsed.issues };
  }

  const overrideResult = parseCliOverrides(input.overrides);
  if (Array.isArray(overrideResult)) {
    return { ok: false, issues: overrideResult };
  }

  const config = applyDefaults(parsed.config, overrideResult, apiKeyPresent(env));
  return { ok: true, config };
}
