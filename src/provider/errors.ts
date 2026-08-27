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

const SENSITIVE_KEY = '(?:api[_-]?key|access[_-]?token|token|secret|authorization)';

export function sanitizeProviderText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      new RegExp(`(${SENSITIVE_KEY}["']?\\s*[:=]\\s*["']?)([^"'\\s,;&]+)`, 'gi'),
      '$1[REDACTED]',
    )
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/gi, '[USER_HOME]')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '[USER_HOME]');
}

function sanitizeDetails(
  details: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (details === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === 'string' ? sanitizeProviderText(value) : value,
    ]),
  );
}

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
  const safeDetails = sanitizeDetails(details);
  return {
    category,
    code,
    message: sanitizeProviderText(message),
    retryable,
    ...(safeDetails ? { details: safeDetails } : {}),
  };
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
    return {
      ...error,
      message: sanitizeProviderText(error.message),
      ...(error.details === undefined
        ? {}
        : { details: sanitizeDetails({ ...error.details }) as NonNullable<EchoError['details']> }),
    };
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'APIUserAbortError') {
    return cancellationError('The model request was cancelled.');
  }
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 401 || status === 403) {
    return providerError(
      'provider_auth',
      'PROVIDER_AUTH_FAILED',
      'The model provider rejected authentication.',
      false,
    );
  }
  if (status === 429) {
    return providerError(
      'provider_rate_limit',
      'PROVIDER_RATE_LIMITED',
      'The model provider rate limit was exceeded.',
      true,
    );
  }
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
    return providerError(
      'provider_protocol',
      'PROVIDER_REQUEST_REJECTED',
      `The model provider rejected the request with HTTP ${String(status)}.`,
      false,
    );
  }
  if (name === 'APIConnectionTimeoutError') {
    return providerError(
      'provider_network',
      'PROVIDER_TIMEOUT',
      'The model provider request timed out.',
      true,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
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
    typeof (value as { category?: unknown }).category === 'string' &&
    'code' in value &&
    typeof (value as { code?: unknown }).code === 'string' &&
    'message' in value &&
    typeof (value as { message?: unknown }).message === 'string' &&
    'retryable' in value &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  );
}

export { delay as sleepForMs };
