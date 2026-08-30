import { describe, expect, it } from 'vitest';

import { WEB_BODY_LIMIT_BYTES } from '../../../src/web/server/index.js';

import { startTestWebServer } from './harness.js';

describe('Web request guards', () => {
  it('enforces Host, Origin, JSON content-type, CSP, and no-store', async () => {
    const harness = await startTestWebServer({ withAssets: true });
    try {
      const badHost = await harness.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: {
          host: 'localhost:9',
          origin: harness.origin,
          'content-type': 'application/json',
        },
        payload: { token: harness.server.bootstrapToken },
      });
      expect(badHost.statusCode).toBe(401);
      expect(badHost.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });

      const nullOrigin = await harness.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: { origin: 'null', 'content-type': 'application/json' },
        payload: { token: harness.server.bootstrapToken },
      });
      expect(nullOrigin.statusCode).toBe(403);
      expect(nullOrigin.json()).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });

      const missingOrigin = await harness.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: { 'content-type': 'application/json' },
        payload: { token: harness.server.bootstrapToken },
      });
      expect(missingOrigin.statusCode).toBe(403);

      const form = await harness.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: { origin: harness.origin, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'token=abc',
      });
      expect(form.statusCode).toBe(400);
      expect(form.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

      const cookie = await harness.bootstrap();
      const ok = await harness.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        cookies: cookie,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(ok.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(ok.headers['x-content-type-options']).toBe('nosniff');
      expect(ok.headers['access-control-allow-origin']).toBeUndefined();

      const page = await harness.inject({ method: 'GET', url: '/' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    } finally {
      await harness.server.close();
    }
  });

  it('rejects an oversize JSON body', async () => {
    const harness = await startTestWebServer();
    try {
      const oversized = await harness.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        payload: { token: 'x'.repeat(WEB_BODY_LIMIT_BYTES + 8) },
      });
      expect(oversized.statusCode).toBeGreaterThanOrEqual(400);
      expect(oversized.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expect(JSON.stringify(oversized.json())).not.toMatch(/stack|ECHO_API_KEY/u);
    } finally {
      await harness.server.close();
    }
  });
});
