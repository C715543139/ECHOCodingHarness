import { describe, expect, it } from 'vitest';

import type { EchoError } from '../../../src/contracts/index.js';
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  sanitizeProviderText,
  shouldRetry,
  toEchoError,
  withRetries,
} from '../../../src/provider/errors.js';

function echoError(category: EchoError['category'], retryable: boolean): EchoError {
  return { category, code: 'TEST', message: 'test', retryable };
}

describe('provider retry policy', () => {
  it('retries rate limit and network errors', () => {
    expect(shouldRetry(echoError('provider_rate_limit', true), 1).retry).toBe(true);
    expect(shouldRetry(echoError('provider_network', true), 1).retry).toBe(true);
  });

  it('does not retry auth, protocol, or non-retryable errors', () => {
    expect(shouldRetry(echoError('provider_auth', false), 1).retry).toBe(false);
    expect(shouldRetry(echoError('provider_protocol', false), 1).retry).toBe(false);
    expect(shouldRetry(echoError('provider_network', false), 1).retry).toBe(false);
  });

  it('stops after the configured attempt budget', () => {
    const policy = { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 };
    expect(shouldRetry(echoError('provider_network', true), 2, policy).retry).toBe(false);
  });

  it('grows the backoff exponentially and caps it', () => {
    const policy = { maxAttempts: 10, initialDelayMs: 100, maxDelayMs: 800 };
    expect(computeBackoffMs(policy, 1)).toBe(100);
    expect(computeBackoffMs(policy, 2)).toBe(200);
    expect(computeBackoffMs(policy, 3)).toBe(400);
    expect(computeBackoffMs(policy, 4)).toBe(800);
    expect(computeBackoffMs(policy, 5)).toBe(800);
  });

  it('retries a failing operation until it succeeds', async () => {
    const policy = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 };
    let attempts = 0;
    const result = await withRetries(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw echoError('provider_network', true);
      }
      return 'ok';
    }, policy);

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('gives up after maxAttempts attempts', async () => {
    const policy = { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 };
    let attempts = 0;
    await expect(
      withRetries(async () => {
        attempts += 1;
        throw echoError('provider_rate_limit', true);
      }, policy),
    ).rejects.toMatchObject({ category: 'provider_rate_limit' });
    expect(attempts).toBe(2);
  });

  it('does not retry non-retryable failures', async () => {
    const policy = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 };
    let attempts = 0;
    await expect(
      withRetries(async () => {
        attempts += 1;
        throw echoError('provider_auth', false);
      }, policy),
    ).rejects.toMatchObject({ category: 'provider_auth' });
    expect(attempts).toBe(1);
  });

  it('uses bounded default retry settings', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeLessThanOrEqual(4);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(10_000);
  });

  it('classifies authentication and rate-limit HTTP errors', () => {
    expect(toEchoError({ status: 401, message: 'unauthorized' })).toMatchObject({
      category: 'provider_auth',
      retryable: false,
    });
    expect(toEchoError({ status: 429, message: 'slow down' })).toMatchObject({
      category: 'provider_rate_limit',
      retryable: true,
    });
    expect(toEchoError({ status: 400, message: 'bad request' })).toMatchObject({
      category: 'provider_protocol',
      retryable: false,
    });
  });

  it('redacts authorization headers, tokens, URL credentials, and query keys', () => {
    const secret = 'sk-supersecretvalue';
    const text = sanitizeProviderText(
      `Authorization: Bearer ${secret} url=https://user:pass@example.test/v1?api_key=${secret} path=C:\\Users\\private-user\\repo`,
    );

    expect(text).not.toContain(secret);
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('private-user');
    expect(text).toContain('[REDACTED]');
  });

  it('sanitizes messages and details on existing EchoErrors', () => {
    const mapped = toEchoError({
      category: 'provider_network',
      code: 'UPSTREAM',
      message: 'Bearer secret-token',
      retryable: true,
      details: { endpoint: 'https://user:pass@example.test', token: 'sk-secretvalue' },
    });

    expect(JSON.stringify(mapped)).not.toContain('secret-token');
    expect(JSON.stringify(mapped)).not.toContain('user:pass');
    expect(JSON.stringify(mapped)).not.toContain('sk-secretvalue');
  });
});
