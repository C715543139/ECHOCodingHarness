import type { SafetyMode } from './safety.js';

export const P1_CONFIG_RELATIVE_PATH = 'config/echo.config.json';

/** Effective source of a session-scoped model or safety setting. Not a config-file merge source. */
export const P1_SETTING_SOURCES = ['cli', 'session', 'config'] as const;

export type P1ConfigSource = (typeof P1_SETTING_SOURCES)[number];

export const CONFIG_ERROR_CODES = {
  invalid: 'CONFIG_INVALID',
  missingFile: 'CONFIG_MISSING',
  unknownKey: 'CONFIG_UNKNOWN_KEY',
  credentialForbidden: 'CONFIG_CREDENTIAL_FORBIDDEN',
  embeddedCredentials: 'CONFIG_EMBEDDED_CREDENTIALS',
  invalidUrl: 'CONFIG_INVALID_URL',
  invalidCatalog: 'CONFIG_INVALID_CATALOG',
  modelNotInCatalog: 'CONFIG_MODEL_NOT_IN_CATALOG',
  missingModel: 'CONFIG_MISSING_MODEL',
  missingApiKey: 'CONFIG_MISSING_API_KEY',
  artifactRoot: 'CONFIG_ARTIFACT_ROOT',
  providerMismatch: 'CONFIG_PROVIDER_MISMATCH',
  sessionIncompatible: 'CONFIG_SESSION_INCOMPATIBLE',
  sessionCorrupt: 'CONFIG_SESSION_CORRUPT',
  sessionNotFound: 'CONFIG_SESSION_NOT_FOUND',
  sessionWorkspaceMismatch: 'CONFIG_SESSION_WORKSPACE_MISMATCH',
  fullAccessConfirmationRequired: 'FULL_ACCESS_CONFIRMATION_REQUIRED',
} as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[keyof typeof CONFIG_ERROR_CODES];

export type ModelCatalogSource = 'discover' | 'manual';

export type ModelCatalogConfig =
  Readonly<{ source: 'discover' }> | Readonly<{ source: 'manual'; models: readonly string[] }>;

export interface EchoPersistentConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly modelCatalog: ModelCatalogConfig;
  readonly safetyMode: SafetyMode;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly requestTimeoutMs?: number;
  readonly context?: Readonly<{
    maxApproxTokens: number;
    reservedOutputTokens: number;
  }>;
}

export interface ConfigIssue {
  readonly code: ConfigErrorCode;
  readonly message: string;
  readonly path?: string;
}

export interface EffectiveSetting<T> {
  readonly value: T;
  readonly source: P1ConfigSource;
}
