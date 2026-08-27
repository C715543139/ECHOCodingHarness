import type { EchoConfig } from './load-config.js';
import type { EchoError } from '../contracts/errors.js';

export type ConfigCheckSeverity = 'error' | 'warning';

export interface ConfigCheckIssue {
  readonly severity: ConfigCheckSeverity;
  readonly message: string;
}

export interface ConfigCheckResult {
  readonly ok: boolean;
  readonly issues: readonly ConfigCheckIssue[];
}

export function createConfigError(message: string): EchoError {
  return {
    category: 'configuration',
    code: 'CONFIG_INVALID',
    message,
    retryable: false,
  };
}

export function checkConfig(config: EchoConfig): ConfigCheckResult {
  const issues: ConfigCheckIssue[] = [];

  if (config.model.length === 0) {
    issues.push({
      severity: 'error',
      message: 'Model name is missing. Set ECHO_MODEL or pass --model.',
    });
  }

  if (!config.apiKeyPresent) {
    issues.push({
      severity: 'error',
      message: 'API key is missing. Set ECHO_API_KEY in the environment.',
    });
  }

  if (config.context.reservedOutputTokens >= config.context.maxApproxTokens) {
    issues.push({
      severity: 'error',
      message: 'Context reservedOutputTokens must be smaller than maxApproxTokens.',
    });
  }

  return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
}
