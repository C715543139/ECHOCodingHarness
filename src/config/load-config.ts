import type { SafetyMode } from '../contracts/safety.js';

export const ENV_KEYS = {
  baseUrl: 'ECHO_BASE_URL',
  apiKey: 'ECHO_API_KEY',
  model: 'ECHO_MODEL',
  safetyMode: 'ECHO_SAFETY_MODE',
} as const;

export const CONFIG_FILE_NAMES = ['echo.config.json', '.echo-config.json'] as const;

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_SAFETY_MODE: SafetyMode = 'balanced';
export const DEFAULT_MAX_STEPS = 24;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
export const DEFAULT_MAX_APPROX_TOKENS = 32_000;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

const SAFETY_MODES: readonly SafetyMode[] = ['safe', 'balanced', 'auto'];

const KNOWN_CONFIG_KEYS = [
  'baseUrl',
  'model',
  'safetyMode',
  'maxSteps',
  'timeoutMs',
  'maxOutputChars',
  'context',
  'requestTimeoutMs',
] as const;

export interface ContextConfig {
  readonly maxApproxTokens: number;
  readonly reservedOutputTokens: number;
}

export interface EchoConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly safetyMode: SafetyMode;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly requestTimeoutMs: number;
  readonly context: ContextConfig;
  readonly apiKeyPresent: boolean;
}

export type ConfigSource = 'cli' | 'env' | 'project' | 'user' | 'default';

export interface ConfigWarning {
  readonly source: ConfigSource;
  readonly message: string;
}

export interface ConfigFileResult {
  readonly config: RawConfigValues | undefined;
}

export interface RawConfigValues {
  readonly baseUrl?: unknown;
  readonly model?: unknown;
  readonly safetyMode?: unknown;
  readonly maxSteps?: unknown;
  readonly timeoutMs?: unknown;
  readonly maxOutputChars?: unknown;
  readonly requestTimeoutMs?: unknown;
  readonly context?: unknown;
}

export interface ConfigLoadResult {
  readonly config: EchoConfig;
  readonly warnings: readonly ConfigWarning[];
}

interface ResolvedValues {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly safetyMode?: SafetyMode;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly requestTimeoutMs?: number;
  readonly maxApproxTokens?: number;
  readonly reservedOutputTokens?: number;
}

interface RawConfig {
  readonly values: RawConfigValues;
  readonly unknownKeys: readonly string[];
}

export interface ConfigInput {
  readonly env?: Record<string, string | undefined>;
  readonly projectConfig?: RawConfigValues | undefined;
  readonly userConfig?: RawConfigValues | undefined;
  readonly overrides?: RawConfigValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function readRawConfig(source: unknown, sourceName: string): RawConfig {
  if (source === undefined || source === null) {
    return { values: {}, unknownKeys: [] };
  }
  if (!isRecord(source)) {
    throw new Error(`${sourceName} must be a JSON object`);
  }
  const values: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if ((KNOWN_CONFIG_KEYS as readonly string[]).includes(key)) {
      values[key] = value;
    } else {
      unknownKeys.push(key);
    }
  }
  return { values: values as RawConfigValues, unknownKeys };
}

function readSafetyMode(value: unknown): SafetyMode | undefined {
  const text = asString(value);
  if (text === undefined) {
    return undefined;
  }
  const normalized = text.toLowerCase();
  return (SAFETY_MODES as readonly string[]).includes(normalized)
    ? (normalized as SafetyMode)
    : undefined;
}

interface FieldIssue {
  readonly key: string;
  readonly source: ConfigSource;
  readonly problem: 'invalid_type' | 'unknown_value';
}

function pick(candidates: readonly { source: ConfigSource; values: RawConfigValues }[]): {
  resolved: ResolvedValues;
  issues: readonly FieldIssue[];
} {
  const issues: FieldIssue[] = [];
  const resolved: Record<string, string | number | SafetyMode> = {};

  const takeString = (key: 'baseUrl' | 'model'): void => {
    for (const candidate of candidates) {
      const raw = candidate.values[key];
      if (raw === undefined) {
        continue;
      }
      const parsed = asString(raw);
      if (parsed === undefined) {
        issues.push({ key, source: candidate.source, problem: 'invalid_type' });
        return;
      }
      resolved[key] = parsed;
      return;
    }
  };

  const takeInt = (key: 'maxSteps' | 'timeoutMs' | 'maxOutputChars' | 'requestTimeoutMs'): void => {
    for (const candidate of candidates) {
      const raw = candidate.values[key];
      if (raw === undefined) {
        continue;
      }
      const parsed = asPositiveInt(raw);
      if (parsed === undefined) {
        issues.push({ key, source: candidate.source, problem: 'invalid_type' });
        return;
      }
      resolved[key] = parsed;
      return;
    }
  };

  const takeSafetyMode = (): void => {
    for (const candidate of candidates) {
      const raw = candidate.values.safetyMode;
      if (raw === undefined) {
        continue;
      }
      const parsed = readSafetyMode(raw);
      if (parsed === undefined) {
        issues.push({ key: 'safetyMode', source: candidate.source, problem: 'unknown_value' });
        return;
      }
      resolved.safetyMode = parsed;
      return;
    }
  };

  const takeContext = (): void => {
    for (const candidate of candidates) {
      const raw = candidate.values.context;
      if (raw === undefined) {
        continue;
      }
      const maxApproxTokens = isRecord(raw) ? asPositiveInt(raw['maxApproxTokens']) : undefined;
      const reservedOutputTokens = isRecord(raw)
        ? asPositiveInt(raw['reservedOutputTokens'])
        : undefined;
      if (maxApproxTokens === undefined || reservedOutputTokens === undefined) {
        issues.push({ key: 'context', source: candidate.source, problem: 'invalid_type' });
        return;
      }
      resolved.maxApproxTokens = maxApproxTokens;
      resolved.reservedOutputTokens = reservedOutputTokens;
      return;
    }
  };

  takeString('baseUrl');
  takeString('model');
  takeSafetyMode();
  takeInt('maxSteps');
  takeInt('timeoutMs');
  takeInt('maxOutputChars');
  takeInt('requestTimeoutMs');
  takeContext();

  return { resolved: resolved as unknown as ResolvedValues, issues };
}

function describeSource(source: ConfigSource): string {
  switch (source) {
    case 'cli':
      return 'CLI arguments';
    case 'env':
      return 'environment variables';
    case 'project':
      return 'project configuration';
    case 'user':
      return 'user configuration';
    case 'default':
      return 'defaults';
  }
}

function describeProblem(problem: FieldIssue['problem']): string {
  return problem === 'unknown_value' ? 'uses an unsupported value' : 'must be a valid value';
}

export function loadConfig(input: ConfigInput = {}): ConfigLoadResult {
  const warnings: ConfigWarning[] = [];
  const env = input.env ?? process.env;
  const apiKey = env[ENV_KEYS.apiKey];
  const apiKeyPresent = typeof apiKey === 'string' && apiKey.trim().length > 0;

  const envValues: RawConfigValues = {
    baseUrl: env[ENV_KEYS.baseUrl],
    model: env[ENV_KEYS.model],
    safetyMode: env[ENV_KEYS.safetyMode],
  };

  const cli = readRawConfig(input.overrides, 'CLI overrides');
  for (const key of cli.unknownKeys) {
    warnings.push({
      source: 'cli',
      message: `Unknown configuration key "${key}" was ignored; check for typos.`,
    });
  }

  const project = readRawConfig(input.projectConfig, 'Project configuration');
  for (const key of project.unknownKeys) {
    warnings.push({
      source: 'project',
      message: `Unknown configuration key "${key}" in project configuration was ignored; check for typos.`,
    });
  }

  const user = readRawConfig(input.userConfig, 'User configuration');
  for (const key of user.unknownKeys) {
    warnings.push({
      source: 'user',
      message: `Unknown configuration key "${key}" in user configuration was ignored; check for typos.`,
    });
  }

  const candidates = [
    { source: 'cli' as const, values: cli.values },
    { source: 'env' as const, values: envValues },
    { source: 'project' as const, values: project.values },
    { source: 'user' as const, values: user.values },
  ];

  const { resolved, issues } = pick(candidates);
  for (const issue of issues) {
    const hint =
      issue.key === 'safetyMode'
        ? ` (${issue.key} must be one of: ${SAFETY_MODES.join(', ')})`
        : '';
    warnings.push({
      source: issue.source,
      message: `${describeSource(issue.source)} provided "${issue.key}" that ${describeProblem(issue.problem)}; it was ignored.${hint}`,
    });
  }

  const config: EchoConfig = {
    baseUrl: resolved.baseUrl ?? DEFAULT_BASE_URL,
    model: resolved.model ?? '',
    safetyMode: resolved.safetyMode ?? DEFAULT_SAFETY_MODE,
    maxSteps: resolved.maxSteps ?? DEFAULT_MAX_STEPS,
    timeoutMs: resolved.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: resolved.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    requestTimeoutMs: resolved.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    context: {
      maxApproxTokens: resolved.maxApproxTokens ?? DEFAULT_MAX_APPROX_TOKENS,
      reservedOutputTokens: resolved.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
    },
    apiKeyPresent,
  };

  return { config, warnings };
}
