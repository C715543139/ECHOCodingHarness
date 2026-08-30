import { describe, expect, it } from 'vitest';

import { findWebPrivacyLeaks, serializedWebValue } from '../../web-fixtures/web-privacy.js';

import {
  ATTACK_HOSTS,
  ATTACK_ORIGINS,
  assertApiSecurityHeaders,
  cookieHeader,
  redeemBootstrap,
  startSecurityFixture,
} from './security-fixture.js';

describe('Fastify security fixture', () => {
  it('rejects DNS-rebinding Host values and cross-origin bootstrap attempts', async () => {
    const harness = await startSecurityFixture();
    try {
      for (const host of ATTACK_HOSTS) {
        const response = await harness.inject({
          method: 'POST',
          url: '/api/v1/auth/bootstrap',
          headers: {
            host,
            origin: harness.origin,
            'content-type': 'application/json',
          },
          payload: { token: harness.server.bootstrapToken },
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(findWebPrivacyLeaks(response.body)).toEqual([]);
      }

      for (const origin of ATTACK_ORIGINS) {
        const response = await harness.inject({
          method: 'POST',
          url: '/api/v1/auth/bootstrap',
          headers: { origin, 'content-type': 'application/json' },
          payload: { token: harness.server.bootstrapToken },
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(response.json())).not.toMatch(/stack|C:\\Users\\/u);
      }
    } finally {
      await harness.server.close();
    }
  });

  it('does not advertise CORS and ignores a foreign process cookie', async () => {
    const harness = await startSecurityFixture();
    const foreign = await startSecurityFixture();
    try {
      const cookie = await redeemBootstrap(harness);
      const snapshot = await harness.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        cookies: cookie,
      });
      expect(snapshot.statusCode).toBe(200);
      assertApiSecurityHeaders(snapshot.headers);
      expect(findWebPrivacyLeaks(serializedWebValue(snapshot.json()))).toEqual([]);

      const preflight = await harness.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'GET',
        },
      });
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

      const stolen = await foreign.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { cookie: cookieHeader(cookie) },
      });
      expect(stolen.statusCode).toBe(401);
      expect(stolen.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } });
    } finally {
      await harness.server.close();
      await foreign.server.close();
    }
  });

  it('registers Session create without weakening request guards or DTO privacy', async () => {
    const harness = await startSecurityFixture();
    try {
      const cookie = await redeemBootstrap(harness);
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': 'req_security_fix01',
        },
        cookies: cookie,
        payload: {},
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        data: {
          session: { phase: 'idle' },
          capabilities: { canSubmitTurn: true },
        },
      });
      expect(findWebPrivacyLeaks(serializedWebValue(created.json()))).toEqual([]);
    } finally {
      await harness.server.close();
    }
  });
});
