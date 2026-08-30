import type { OutgoingHttpHeaders } from 'node:http';

import { WEB_AUTH_COOKIE } from '../../../src/web/server/index.js';

import { startTestWebServer, type TestWebServer } from './harness.js';

export const ATTACK_HOSTS = ['localhost:9', '127.0.0.1.attacker.test', 'example.invalid'] as const;
export const ATTACK_ORIGINS = ['null', 'http://127.0.0.1:1', 'https://evil.example'] as const;

export async function startSecurityFixture(
  overrides: { readonly withAssets?: boolean } = {},
): Promise<TestWebServer> {
  return startTestWebServer(overrides);
}

export function cookieHeader(value: string): string {
  return `${WEB_AUTH_COOKIE}=${value}`;
}

export function assertNoCors(headers: OutgoingHttpHeaders): void {
  if (headers['access-control-allow-origin'] !== undefined) {
    throw new Error('Response advertised a CORS origin.');
  }
}

export function assertApiSecurityHeaders(headers: OutgoingHttpHeaders): void {
  if (headers['cache-control'] !== 'no-store') {
    throw new Error('API response missing Cache-Control: no-store.');
  }
  const csp = headers['content-security-policy'];
  if (typeof csp !== 'string' || !csp.includes("frame-ancestors 'none'")) {
    throw new Error('API response missing frame-ancestors CSP.');
  }
  if (headers['x-content-type-options'] !== 'nosniff') {
    throw new Error('API response missing X-Content-Type-Options: nosniff.');
  }
  assertNoCors(headers);
}

export function assertBootstrapCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (header === undefined) {
    throw new Error('Bootstrap Set-Cookie header missing.');
  }
  if (!header.includes('HttpOnly') || !header.includes('SameSite=Strict')) {
    throw new Error('Bootstrap cookie missing HttpOnly SameSite=Strict.');
  }
  if (!header.includes('Path=/api/v1')) {
    throw new Error('Bootstrap cookie Path is not /api/v1.');
  }
  const match = new RegExp(`${WEB_AUTH_COOKIE}=([^;]+)`, 'u').exec(header);
  if (match?.[1] === undefined) {
    throw new Error('Bootstrap cookie value missing.');
  }
  return match[1];
}

export async function redeemBootstrap(harness: TestWebServer): Promise<string> {
  const response = await harness.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    headers: { origin: harness.origin, 'content-type': 'application/json' },
    payload: { token: harness.server.bootstrapToken },
  });
  if (response.statusCode !== 204) {
    throw new Error(`Bootstrap expected 204, got ${String(response.statusCode)}`);
  }
  return assertBootstrapCookie(response.headers['set-cookie']);
}
