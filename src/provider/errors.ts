import type { EchoError } from '../contracts/errors.js';

export interface ProviderRetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: ProviderRetryPolicy = {
  maxAttempts: 2,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
};

export const RETRYABLE_CATEGORIES: readonly string[] = ['provider_rate_limit', 'provider_network'];

export function providerError(
  category:
    | 'provider_auth'
    | 'provider_rate_limit'
    | 'provider_network'
    | 'provider_protocol'
    | 'cancelled',
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, string | number | boolean | null>,
): EchoError {
  return { category, code, message, retryable, ...(details ? { details } : {}) };
}

export function cancellationError(message: string): EchoError {
  return { category: 'cancelled', code: 'PROVIDER_CANCELLED', message, retryable: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function computeBackoffMs(policy: ProviderRetryPolicy, attempt: number): number {
  const exponential = policy.initialDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, policy.maxDelayMs);
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly attempt: number;
}

export function shouldRetry(
  error: EchoError,
  attempt: number,
  policy: ProviderRetryPolicy = DEFAULT_RETRY_POLICY,
): RetryDecision {
  const retryable = error.retryable && RETRYABLE_CATEGORIES.includes(error.category);
  if (!retryable || attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, attempt };
  }
  return { retry: true, delayMs: computeBackoffMs(policy, attempt), attempt };
}

export async function withRetries<T>(
  operation: (attempt: number) => Promise<T>,
  policy: ProviderRetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await operation(attempt);
    } catch (error) {
      const echoError = toEchoError(error);
      const decision = shouldRetry(echoError, attempt, policy);
      if (!decision.retry) {
        throw echoError;
      }
      await delay(decision.delayMs);
      attempt += 1;
    }
  }
}

export function toEchoError(error: unknown): EchoError {
  if (isEchoError(error)) {
    return error;
  }
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError' || name === 'APIUserAbortError') {
    return cancellationError('The model request was cancelled.');
  }
  return providerError(
    'provider_network',
    'PROVIDER_REQUEST_FAILED',
    `The model request failed: ${message}`,
    true,
  );
}

export function isEchoError(value: unknown): value is EchoError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'category' in value &&
    'code' in value &&
    'retryable' in value
  );
}

export { delay as sleepForMs };
