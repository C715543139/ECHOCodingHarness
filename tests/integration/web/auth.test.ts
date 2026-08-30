import { describe, expect, it } from 'vitest';

import { WEB_AUTH_COOKIE } from '../../../src/web/server/index.js';

import { startTestWebServer } from './harness.js';

describe('Web bootstrap authentication', () => {
  it('redeems a one-time token as an HttpOnly Strict process cookie', async () => {
    const harness = await startTestWebServer();
    try {
      const first = await harness.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        payload: { token: harness.server.bootstrapToken },
      });
      expect(first.statusCode).toBe(204);
      const setCookie = first.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(header).toContain(`${WEB_AUTH_COOKIE}=`);
      expect(header).toMatch(/HttpOnly/u);
      expect(header).toMatch(/SameSite=Strict/u);
      expect(header).toMatch(/Path=\/api\/v1/u);
      expect(header).not.toMatch(/Max-Age/iu);
      expect(header).not.toMatch(/Expires=/iu);

      const replay = await harness.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        payload: { token: harness.server.bootstrapToken },
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
      expect(JSON.stringify(replay.json())).not.toMatch(/already|expired|unknown/iu);

      const wrong = await startTestWebServer();
      try {
        const denied = await wrong.inject({
          method: 'POST',
          url: '/api/v1/auth/bootstrap',
          headers: { origin: wrong.origin, 'content-type': 'application/json' },
          payload: { token: 'a'.repeat(64) },
        });
        expect(denied.statusCode).toBe(401);
        expect(denied.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
      } finally {
        await wrong.server.close();
      }

      const unauthenticated = await harness.inject({ method: 'GET', url: '/api/v1/bootstrap' });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    } finally {
      await harness.server.close();
    }
  });
});
