import {
  CONFIG_ERROR_CODES,
  P1_CONFIG_RELATIVE_PATH,
  type ConfigIssue,
  type EchoPersistentConfig,
  type ModelCatalogConfig,
} from '../contracts/config.js';
import type { SafetyMode } from '../contracts/safety.js';

export const SAFETY_MODES: readonly SafetyMode[] = ['safe', 'balanced', 'auto'];

export const PERSISTENT_CONFIG_KEYS = [
  'baseUrl',
  'model',
  'modelCatalog',
  'safetyMode',
  'maxSteps',
  'timeoutMs',
  'maxOutputChars',
  'requestTimeoutMs',
  'context',
] as const;

const CREDENTIAL_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'headers',
  'token',
  'accesstoken',
  'secret',
  'password',
]);

export interface ParsedPersistentConfig {
  readonly config: EchoPersistentConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(code: ConfigIssue['code'], message: string, path?: string): ConfigIssue {
  return path === undefined ? { code, message } : { code, message, path };
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

export function inspectProviderUrl(value: unknown): ConfigIssue | { readonly href: string } {
  const text = asNonEmptyString(value);
  if (text === undefined) {
    return issue(
      CONFIG_ERROR_CODES.invalidUrl,
      'Provider baseUrl must be a non-empty HTTP or HTTPS URL.',
      'baseUrl',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return issue(
      CONFIG_ERROR_CODES.invalidUrl,
      'Provider baseUrl must be a valid HTTP or HTTPS URL.',
      'baseUrl',
    );
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
    return issue(
      CONFIG_ERROR_CODES.invalidUrl,
      'Provider baseUrl must be a valid HTTP or HTTPS URL.',
      'baseUrl',
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return issue(
      CONFIG_ERROR_CODES.embeddedCredentials,
      'Provider baseUrl must not contain embedded credentials.',
      'baseUrl',
    );
  }
  return { href: text };
}

function parseSafetyMode(value: unknown): ConfigIssue | SafetyMode {
  const text = asNonEmptyString(value);
  if (text === undefined) {
    return issue(
      CONFIG_ERROR_CODES.invalid,
      `safetyMode must be one of: ${SAFETY_MODES.join(', ')}.`,
      'safetyMode',
    );
  }
  const normalized = text.toLowerCase();
  if (!(SAFETY_MODES as readonly string[]).includes(normalized)) {
    return issue(
      CONFIG_ERROR_CODES.invalid,
      `safetyMode must be one of: ${SAFETY_MODES.join(', ')}.`,
      'safetyMode',
    );
  }
  return normalized as SafetyMode;
}

function parseModelCatalog(value: unknown): ConfigIssue[] | ModelCatalogConfig {
  if (!isRecord(value)) {
    return [
      issue(
        CONFIG_ERROR_CODES.invalidCatalog,
        'modelCatalog must be an object with source "discover" or "manual".',
        'modelCatalog',
      ),
    ];
  }

  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'source' && key !== 'models') {
      issues.push(
        issue(
          CONFIG_ERROR_CODES.unknownKey,
          `Unknown configuration key "${key}".`,
          `modelCatalog.${key}`,
        ),
      );
    }
  }

  const source = asNonEmptyString(value['source']);
  if (source !== 'discover' && source !== 'manual') {
    issues.push(
      issue(
        CONFIG_ERROR_CODES.invalidCatalog,
        'modelCatalog.source must be "discover" or "manual".',
        'modelCatalog.source',
      ),
    );
    return issues;
  }

  if (source === 'discover') {
    if (value['models'] !== undefined) {
      issues.push(
        issue(
          CONFIG_ERROR_CODES.invalidCatalog,
          'Discover catalog must not persist a model list; store only the default model.',
          'modelCatalog.models',
        ),
      );
    }
    return issues.length > 0 ? issues : { source: 'discover' };
  }

  const modelsRaw = value['models'];
  if (!Array.isArray(modelsRaw)) {
    issues.push(
      issue(
        CONFIG_ERROR_CODES.invalidCatalog,
        'Manual catalog must include a models array of unique non-empty model IDs.',
        'modelCatalog.models',
      ),
    );
    return issues;
  }

  const models: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of modelsRaw.entries()) {
    const id = asNonEmptyString(entry);
    if (id === undefined) {
      issues.push(
        issue(
          CONFIG_ERROR_CODES.invalidCatalog,
          'Manual catalog model IDs must be unique, non-empty strings.',
          `modelCatalog.models[${String(index)}]`,
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      issues.push(
        issue(
          CONFIG_ERROR_CODES.invalidCatalog,
          `Manual catalog contains duplicate model ID "${id}".`,
          `modelCatalog.models[${String(index)}]`,
        ),
      );
      continue;
    }
    seen.add(id);
    models.push(id);
  }

  if (models.length === 0 && issues.length === 0) {
    issues.push(
      issue(
        CONFIG_ERROR_CODES.invalidCatalog,
        'Manual catalog must include at least one unique non-empty model ID.',
        'modelCatalog.models',
      ),
    );
  }

  return issues.length > 0 ? issues : { source: 'manual', models };
}

function parseContext(
  value: unknown,
): ConfigIssue[] | { readonly maxApproxTokens: number; readonly reservedOutputTokens: number } {
  if (!isRecord(value)) {
    return [
      issue(
        CONFIG_ERROR_CODES.invalid,
        'context must be an object with maxApproxTokens and reservedOutputTokens.',
        'context',
      ),
    ];
  }
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'maxApproxTokens' && key !== 'reservedOutputTokens') {
      issues.push(
        issue(
          CONFIG_ERROR_CODES.unknownKey,
          `Unknown configuration key "${key}".`,
          `context.${key}`,
        ),
      );
    }
  }
  const maxApproxTokens = asPositiveInt(value['maxApproxTokens']);
  const reservedOutputTokens = asPositiveInt(value['reservedOutputTokens']);
  if (maxApproxTokens === undefined) {
    issues.push(
      issue(
        CONFIG_ERROR_CODES.invalid,
        'context.maxApproxTokens must be a positive approximate token integer.',
        'context.maxApproxTokens',
      ),
    );
  }
  if (reservedOutputTokens === undefined) {
    issues.push(
      issue(
        CONFIG_ERROR_CODES.invalid,
        'context.reservedOutputTokens must be a positive approximate token integer.',
        'context.reservedOutputTokens',
      ),
    );
  }
  if (maxApproxTokens !== undefined && reservedOutputTokens !== undefined) {
    if (reservedOutputTokens >= maxApproxTokens) {
      issues.push(
        issue(
          CONFIG_ERROR_CODES.invalid,
          'Context reservedOutputTokens must be smaller than maxApproxTokens. Both values are approximate token budgets.',
          'context',
        ),
      );
    }
  }
  if (issues.length > 0 || maxApproxTokens === undefined || reservedOutputTokens === undefined) {
    return issues;
  }
  return { maxApproxTokens, reservedOutputTokens };
}

export function parsePersistentConfig(
  raw: unknown,
): ParsedPersistentConfig | { issues: ConfigIssue[] } {
  if (raw === undefined || raw === null) {
    return {
      issues: [
        issue(
          CONFIG_ERROR_CODES.missingFile,
          `Configuration file is missing. Run echo-harness config to create ${P1_CONFIG_RELATIVE_PATH}.`,
        ),
      ],
    };
  }
  if (!isRecord(raw)) {
    return {
      issues: [issue(CONFIG_ERROR_CODES.invalid, 'Configuration file root must be a JSON object.')],
    };
  }

  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(raw)) {
    const normalized = key.toLowerCase();
    if (CREDENTIAL_KEYS.has(normalized)) {
      issues.push(
        issue(
          CONFIG_ERROR_CODES.credentialForbidden,
          `Configuration must not contain credentials ("${key}"). Keep secrets in ECHO_API_KEY.`,
          key,
        ),
      );
      continue;
    }
    if (!(PERSISTENT_CONFIG_KEYS as readonly string[]).includes(key)) {
      issues.push(
        issue(
          CONFIG_ERROR_CODES.unknownKey,
          `Unknown configuration key "${key}". Check for typos; unknown keys are rejected.`,
          key,
        ),
      );
    }
  }

  const baseUrl = inspectProviderUrl(raw['baseUrl']);
  if ('code' in baseUrl) {
    issues.push(baseUrl);
  }

  const model = asNonEmptyString(raw['model']);
  if (model === undefined) {
    issues.push(
      issue(
        CONFIG_ERROR_CODES.missingModel,
        'Model name is missing. Run echo-harness config or pass --model.',
        'model',
      ),
    );
  }

  if (raw['modelCatalog'] === undefined) {
    issues.push(
      issue(
        CONFIG_ERROR_CODES.invalidCatalog,
        'modelCatalog is required and must use source "discover" or "manual".',
        'modelCatalog',
      ),
    );
  }
  const catalog =
    raw['modelCatalog'] === undefined ? undefined : parseModelCatalog(raw['modelCatalog']);
  if (Array.isArray(catalog)) {
    issues.push(...catalog);
  }

  let safetyMode: SafetyMode | undefined;
  if (raw['safetyMode'] !== undefined) {
    const parsed = parseSafetyMode(raw['safetyMode']);
    if (typeof parsed === 'string') {
      safetyMode = parsed;
    } else {
      issues.push(parsed);
    }
  }

  const takeInt = (
    key: 'maxSteps' | 'timeoutMs' | 'maxOutputChars' | 'requestTimeoutMs',
  ): number | undefined => {
    if (raw[key] === undefined) {
      return undefined;
    }
    const parsed = asPositiveInt(raw[key]);
    if (parsed === undefined) {
      issues.push(issue(CONFIG_ERROR_CODES.invalid, `${key} must be a positive integer.`, key));
      return undefined;
    }
    return parsed;
  };

  const maxSteps = takeInt('maxSteps');
  const timeoutMs = takeInt('timeoutMs');
  const maxOutputChars = takeInt('maxOutputChars');
  const requestTimeoutMs = takeInt('requestTimeoutMs');

  let context: EchoPersistentConfig['context'];
  if (raw['context'] !== undefined) {
    const parsed = parseContext(raw['context']);
    if (Array.isArray(parsed)) {
      issues.push(...parsed);
    } else {
      context = parsed;
    }
  }

  if (
    issues.length > 0 ||
    model === undefined ||
    catalog === undefined ||
    Array.isArray(catalog) ||
    !('href' in baseUrl)
  ) {
    return {
      issues:
        issues.length > 0
          ? issues
          : [issue(CONFIG_ERROR_CODES.invalid, 'Configuration is invalid.')],
    };
  }

  if (catalog.source === 'manual' && !catalog.models.includes(model)) {
    return {
      issues: [
        issue(
          CONFIG_ERROR_CODES.modelNotInCatalog,
          `Default model "${model}" is not in the manual catalog.`,
          'model',
        ),
      ],
    };
  }

  const config: EchoPersistentConfig = {
    baseUrl: baseUrl.href,
    model,
    modelCatalog: catalog,
    safetyMode: safetyMode ?? 'balanced',
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(context === undefined ? {} : { context }),
  };
  return { config };
}

export function serializePersistentConfig(config: EchoPersistentConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    modelCatalog:
      config.modelCatalog.source === 'discover'
        ? { source: 'discover' }
        : { source: 'manual', models: [...config.modelCatalog.models] },
    safetyMode: config.safetyMode,
    ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxOutputChars === undefined ? {} : { maxOutputChars: config.maxOutputChars }),
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
    ...(config.context === undefined ? {} : { context: { ...config.context } }),
  };
}
