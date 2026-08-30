import * as path from 'node:path';

import {
  CONFIG_ERROR_CODES,
  P1_CONFIG_RELATIVE_PATH,
  type ConfigIssue,
  type EchoPersistentConfig,
  type ModelCatalogConfig,
} from '../contracts/config.js';
import type { EchoError } from '../contracts/errors.js';
import { sanitizeProviderText } from '../provider/errors.js';
import { uniqueModelIds } from '../provider/model-catalog.js';

import { isAbsoluteArtifactRoot, persistentConfigPath } from './artifact-root.js';
import { readPersistentConfigFile } from './config-file.js';
import { DEFAULT_SAFETY_MODE, ENV_KEYS } from './load-config.js';
import { inspectProviderUrl, parsePersistentConfig } from './schema.js';
import { writePersistentConfigFile } from './write-config.js';

const PROVIDER_SETTINGS_KEYS = new Set(['baseUrl', 'catalog', 'defaultModel']);
const FORBIDDEN_SETTING_KEY = /api[_-]?key|authorization|credential|secret|token|password/iu;

export interface ProviderSettingsDraft {
  readonly baseUrl: string;
  readonly catalog: ModelCatalogConfig;
  readonly defaultModel: string;
}

export interface ProviderConfigSnapshot {
  readonly persistent: EchoPersistentConfig;
  readonly apiKeyConfigured: boolean;
  readonly cachedModels: readonly string[];
}

export interface DiscoveredModels {
  readonly models: readonly string[];
  readonly fetchedAt: string;
}

export type ProviderConfigResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export type ProviderDiscoverResult =
  | { readonly ok: true; readonly value: DiscoveredModels }
  | { readonly ok: false; readonly error: EchoError };

export interface ListProviderModelsInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}

export interface CreateProviderConfigServiceOptions {
  readonly artifactRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly listModelIds?: (input: ListProviderModelsInput) => Promise<readonly string[]>;
  readonly now?: () => Date;
}

export interface ProviderConfigService {
  readonly artifactRoot: string;
  read(): Promise<ProviderConfigResult<ProviderConfigSnapshot>>;
  validateProviderSettings(input: unknown): ProviderConfigResult<ProviderSettingsDraft>;
  validatePersistentConfig(input: unknown): ProviderConfigResult<EchoPersistentConfig>;
  saveProviderSettings(input: unknown): Promise<ProviderConfigResult<ProviderConfigSnapshot>>;
  replacePersistentConfig(input: unknown): Promise<ProviderConfigResult<ProviderConfigSnapshot>>;
  discoverModels(
    baseUrl: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProviderDiscoverResult>;
}

const discoverCache = new Map<string, readonly string[]>();
const writeLocks = new Map<string, Promise<unknown>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envApiKey(env: Record<string, string | undefined>): string {
  const value = env[ENV_KEYS.apiKey];
  return typeof value === 'string' ? value.trim() : '';
}

function artifactRootIssues(artifactRoot: string): ConfigIssue[] | undefined {
  if (!isAbsoluteArtifactRoot(artifactRoot)) {
    return [
      {
        code: CONFIG_ERROR_CODES.artifactRoot,
        message:
          'artifact-root must be an absolute path derived from the CLI entry, not process.cwd().',
      },
    ];
  }
  return undefined;
}

function isForbiddenSettingKey(key: string): boolean {
  return FORBIDDEN_SETTING_KEY.test(key);
}

function settingsFieldIssues(raw: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(raw)) {
    if (isForbiddenSettingKey(key)) {
      issues.push({
        code: CONFIG_ERROR_CODES.credentialForbidden,
        message: `Configuration must not contain credentials ("${key}"). Keep secrets in ECHO_API_KEY.`,
        path: key,
      });
      continue;
    }
    if (!PROVIDER_SETTINGS_KEYS.has(key)) {
      issues.push({
        code: CONFIG_ERROR_CODES.unknownKey,
        message: `Unknown configuration key "${key}". Check for typos; unknown keys are rejected.`,
        path: key,
      });
    }
  }
  return issues;
}

function persistKnownFields(existing: EchoPersistentConfig | undefined): Record<string, unknown> {
  if (existing === undefined) {
    return { safetyMode: DEFAULT_SAFETY_MODE };
  }
  return {
    safetyMode: existing.safetyMode,
    ...(existing.maxSteps === undefined ? {} : { maxSteps: existing.maxSteps }),
    ...(existing.timeoutMs === undefined ? {} : { timeoutMs: existing.timeoutMs }),
    ...(existing.maxOutputChars === undefined ? {} : { maxOutputChars: existing.maxOutputChars }),
    ...(existing.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: existing.requestTimeoutMs }),
    ...(existing.context === undefined ? {} : { context: { ...existing.context } }),
  };
}

function replaceLiteral(text: string, value: string, replacement: string): string {
  if (value.length === 0) {
    return text;
  }
  return text.split(value).join(replacement);
}

function replacePathVariants(text: string, value: string, replacement: string): string {
  let next = replaceLiteral(text, value, replacement);
  const slashed = value.replaceAll('\\', '/');
  if (slashed !== value) {
    next = replaceLiteral(next, slashed, replacement);
  }
  return next;
}

export function redactConfigIssues(
  issues: readonly ConfigIssue[],
  artifactRoot: string,
  secrets: readonly string[],
): ConfigIssue[] {
  return issues.map((issue) => {
    const message = redactConfigText(issue.message, artifactRoot, secrets);
    const issuePath =
      issue.path === undefined ? undefined : redactIssuePath(issue.path, artifactRoot);
    return issuePath === undefined
      ? { code: issue.code, message }
      : { code: issue.code, message, path: issuePath };
  });
}

function redactIssuePath(issuePath: string, artifactRoot: string): string {
  if (
    issuePath === persistentConfigPath(artifactRoot) ||
    issuePath.replaceAll('\\', '/') === persistentConfigPath(artifactRoot).replaceAll('\\', '/')
  ) {
    return P1_CONFIG_RELATIVE_PATH;
  }
  if (isAbsoluteArtifactRoot(issuePath)) {
    return P1_CONFIG_RELATIVE_PATH;
  }
  return issuePath;
}

function redactConfigText(text: string, artifactRoot: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = replaceLiteral(redacted, secret, '[REDACTED]');
  }
  redacted = replacePathVariants(
    redacted,
    persistentConfigPath(artifactRoot),
    P1_CONFIG_RELATIVE_PATH,
  );
  redacted = replacePathVariants(redacted, artifactRoot, '<artifact-root>');
  return sanitizeProviderText(redacted);
}

function failIssues(
  issues: readonly ConfigIssue[],
  artifactRoot: string,
  secrets: readonly string[],
): ProviderConfigResult<never> {
  return { ok: false, issues: redactConfigIssues(issues, artifactRoot, secrets) };
}

function toDiscoverError(
  error: unknown,
  artifactRoot: string,
  secrets: readonly string[],
): EchoError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as ConfigIssue).code === 'string' &&
    typeof (error as ConfigIssue).message === 'string'
  ) {
    const typed = error as ConfigIssue & Partial<EchoError>;
    return {
      category: typed.category ?? 'configuration',
      code: typed.code,
      message: redactConfigText(typed.message, artifactRoot, secrets),
      retryable: typed.retryable === true,
    };
  }
  const message = error instanceof Error ? error.message : 'Model discovery failed.';
  return {
    category: 'provider_protocol',
    code: 'PROVIDER_MODEL_LIST_FAILED',
    message: redactConfigText(message, artifactRoot, secrets),
    retryable: false,
  };
}

function cacheKeyFor(baseUrl: string): string {
  return `provider-config:${baseUrl}`;
}

/**
 * Normalize the in-process write-lock key. Windows treats the same path with
 * different case as one file; POSIX does not. `platform` is injectable so tests
 * do not depend on the current OS.
 */
export function normalizeConfigWriteLockKey(
  configPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(configPath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function withWriteLock<T>(artifactRoot: string, run: () => Promise<T>): Promise<T> {
  const key = normalizeConfigWriteLockKey(persistentConfigPath(artifactRoot));
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  writeLocks.set(key, chained);
  try {
    await previous.catch(() => undefined);
    return await run();
  } finally {
    release();
    if (writeLocks.get(key) === chained) {
      writeLocks.delete(key);
    }
  }
}

async function defaultListModelIds(input: ListProviderModelsInput): Promise<readonly string[]> {
  const { createOpenAIClient } = await import('../provider/openai-client.js');
  const client = createOpenAIClient({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
  return client.listModelIds({
    signal: input.signal ?? new AbortController().signal,
  });
}

export function createProviderConfigService(
  options: CreateProviderConfigServiceOptions,
): ProviderConfigService {
  const artifactRoot = options.artifactRoot;
  const env = options.env ?? {};
  const listModelIds = options.listModelIds ?? defaultListModelIds;
  const now = options.now ?? (() => new Date());

  const secrets = (): string[] => {
    const key = envApiKey(env);
    return key.length === 0 ? [] : [key];
  };

  const snapshotFrom = (persistent: EchoPersistentConfig): ProviderConfigSnapshot => {
    const cached =
      persistent.modelCatalog.source === 'discover'
        ? (discoverCache.get(cacheKeyFor(persistent.baseUrl)) ?? [])
        : [];
    return {
      persistent,
      apiKeyConfigured: envApiKey(env).length > 0,
      cachedModels: [...cached],
    };
  };

  const parseSettings = (input: unknown): ProviderConfigResult<ProviderSettingsDraft> => {
    const rootIssues = artifactRootIssues(artifactRoot);
    if (rootIssues !== undefined) {
      return failIssues(rootIssues, artifactRoot, secrets());
    }
    if (!isRecord(input)) {
      return failIssues(
        [
          {
            code: CONFIG_ERROR_CODES.invalid,
            message: 'Provider settings must be a JSON object.',
          },
        ],
        artifactRoot,
        secrets(),
      );
    }
    const fieldIssues = settingsFieldIssues(input);
    if (fieldIssues.length > 0) {
      return failIssues(fieldIssues, artifactRoot, secrets());
    }
    const mapped = {
      baseUrl: input['baseUrl'],
      model: input['defaultModel'],
      modelCatalog: input['catalog'],
      safetyMode: DEFAULT_SAFETY_MODE,
    };
    const parsed = parsePersistentConfig(mapped);
    if ('issues' in parsed) {
      return failIssues(parsed.issues, artifactRoot, secrets());
    }
    return {
      ok: true,
      value: {
        baseUrl: parsed.config.baseUrl,
        catalog: parsed.config.modelCatalog,
        defaultModel: parsed.config.model,
      },
    };
  };

  const parsePersistent = (input: unknown): ProviderConfigResult<EchoPersistentConfig> => {
    const rootIssues = artifactRootIssues(artifactRoot);
    if (rootIssues !== undefined) {
      return failIssues(rootIssues, artifactRoot, secrets());
    }
    const parsed = parsePersistentConfig(input);
    if ('issues' in parsed) {
      return failIssues(parsed.issues, artifactRoot, secrets());
    }
    return { ok: true, value: parsed.config };
  };

  const loadExisting = async (): Promise<
    ProviderConfigResult<EchoPersistentConfig | undefined>
  > => {
    const rootIssues = artifactRootIssues(artifactRoot);
    if (rootIssues !== undefined) {
      return failIssues(rootIssues, artifactRoot, secrets());
    }
    const file = await readPersistentConfigFile(artifactRoot);
    if (file.status === 'missing') {
      return { ok: true, value: undefined };
    }
    if (file.status === 'error') {
      return failIssues([file.issue], artifactRoot, secrets());
    }
    const parsed = parsePersistentConfig(file.raw);
    if ('issues' in parsed) {
      return failIssues(parsed.issues, artifactRoot, secrets());
    }
    return { ok: true, value: parsed.config };
  };

  const writeConfig = async (
    config: EchoPersistentConfig,
  ): Promise<ProviderConfigResult<ProviderConfigSnapshot>> => {
    try {
      await writePersistentConfigFile(artifactRoot, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Configuration write failed.';
      return failIssues([{ code: CONFIG_ERROR_CODES.invalid, message }], artifactRoot, secrets());
    }
    return { ok: true, value: snapshotFrom(config) };
  };

  return {
    artifactRoot,
    async read() {
      const loaded = await loadExisting();
      if (!loaded.ok) {
        return loaded;
      }
      if (loaded.value === undefined) {
        return failIssues(
          [
            {
              code: CONFIG_ERROR_CODES.missingFile,
              message: `Configuration file is missing (${P1_CONFIG_RELATIVE_PATH}). Run echo-harness config.`,
              path: P1_CONFIG_RELATIVE_PATH,
            },
          ],
          artifactRoot,
          secrets(),
        );
      }
      return { ok: true, value: snapshotFrom(loaded.value) };
    },
    validateProviderSettings(input) {
      return parseSettings(input);
    },
    validatePersistentConfig(input) {
      return parsePersistent(input);
    },
    async saveProviderSettings(input) {
      return withWriteLock(artifactRoot, async () => {
        const settings = parseSettings(input);
        if (!settings.ok) {
          return settings;
        }
        const existing = await loadExisting();
        if (!existing.ok) {
          return existing;
        }
        const merged = parsePersistent({
          ...persistKnownFields(existing.value),
          baseUrl: settings.value.baseUrl,
          model: settings.value.defaultModel,
          modelCatalog: settings.value.catalog,
        });
        if (!merged.ok) {
          return merged;
        }
        return writeConfig(merged.value);
      });
    },
    async replacePersistentConfig(input) {
      return withWriteLock(artifactRoot, async () => {
        const parsed = parsePersistent(input);
        if (!parsed.ok) {
          return parsed;
        }
        return writeConfig(parsed.value);
      });
    },
    async discoverModels(baseUrl, options = {}) {
      const rootIssues = artifactRootIssues(artifactRoot);
      if (rootIssues !== undefined) {
        return { ok: false, error: toDiscoverError(rootIssues[0], artifactRoot, secrets()) };
      }
      const inspected = inspectProviderUrl(baseUrl);
      if ('code' in inspected) {
        return {
          ok: false,
          error: {
            category: 'configuration',
            code: inspected.code,
            message: redactConfigText(inspected.message, artifactRoot, secrets()),
            retryable: false,
          },
        };
      }
      const apiKey = envApiKey(env);
      if (apiKey.length === 0) {
        return {
          ok: false,
          error: {
            category: 'configuration',
            code: CONFIG_ERROR_CODES.missingApiKey,
            message: 'API key is missing. Set ECHO_API_KEY in the environment.',
            retryable: false,
          },
        };
      }
      try {
        const models = uniqueModelIds(
          await listModelIds({
            baseUrl: inspected.href,
            apiKey,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
        );
        if (models.length === 0) {
          return {
            ok: false,
            error: {
              category: 'provider_protocol',
              code: 'PROVIDER_MODEL_LIST_EMPTY',
              message: 'The model catalog response did not include any model IDs.',
              retryable: false,
            },
          };
        }
        discoverCache.set(cacheKeyFor(inspected.href), models);
        return {
          ok: true,
          value: {
            models,
            fetchedAt: now().toISOString(),
          },
        };
      } catch (error) {
        return { ok: false, error: toDiscoverError(error, artifactRoot, secrets()) };
      }
    },
  };
}

/** Test-only hook so discover cache does not leak across cases. */
export function clearProviderConfigDiscoverCache(): void {
  discoverCache.clear();
}
