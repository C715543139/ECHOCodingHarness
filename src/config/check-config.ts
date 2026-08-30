import { CONFIG_ERROR_CODES, type ConfigIssue } from '../contracts/config.js';
import type { EchoError } from '../contracts/errors.js';

import type { EchoConfig } from './load-config.js';
import { inspectProviderUrl, SAFETY_MODES } from './schema.js';

export type ConfigCheckSeverity = 'error' | 'warning';

export interface ConfigCheckIssue {
  readonly severity: ConfigCheckSeverity;
  readonly code: ConfigIssue['code'];
  readonly message: string;
}

export interface ConfigCheckResult {
  readonly ok: boolean;
  readonly issues: readonly ConfigCheckIssue[];
}

export function createConfigError(message: string, code = CONFIG_ERROR_CODES.invalid): EchoError {
  return {
    category: 'configuration',
    code,
    message,
    retryable: false,
  };
}

export function checkConfig(config: EchoConfig): ConfigCheckResult {
  const issues: ConfigCheckIssue[] = [];

  const url = inspectProviderUrl(config.baseUrl);
  if ('code' in url) {
    issues.push({ severity: 'error', code: url.code, message: url.message });
  }

  if (!(SAFETY_MODES as readonly string[]).includes(config.safetyMode)) {
    issues.push({
      severity: 'error',
      code: CONFIG_ERROR_CODES.invalid,
      message: `Safety mode must be one of: ${SAFETY_MODES.join(', ')}.`,
    });
  }

  if (config.model.length === 0) {
    issues.push({
      severity: 'error',
      code: CONFIG_ERROR_CODES.missingModel,
      message: 'Model name is missing. Run echo-harness config or pass --model.',
    });
  }

  if (!config.apiKeyPresent) {
    issues.push({
      severity: 'error',
      code: CONFIG_ERROR_CODES.missingApiKey,
      message: 'API key is missing. Set ECHO_API_KEY in the environment.',
    });
  }

  if (config.context.reservedOutputTokens >= config.context.maxApproxTokens) {
    issues.push({
      severity: 'error',
      code: CONFIG_ERROR_CODES.invalid,
      message:
        'Context reservedOutputTokens must be smaller than maxApproxTokens. Both values are approximate token budgets.',
    });
  }

  return { ok: issues.every((item) => item.severity !== 'error'), issues };
}
