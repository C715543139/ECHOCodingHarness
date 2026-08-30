import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupSessionApiHarnesses, startSessionApiHarness } from './session-api-harness.js';
import { startTestWebServer } from './harness.js';

afterEach(async () => {
  await cleanupSessionApiHarnesses();
});

describe('P2-C1 production route assembly', () => {
  it('starts without an API key and exposes provider-unavailable capabilities', async () => {
    const harness = await startTestWebServer({ env: {} });
    try {
      const cookie = await harness.bootstrap();
      const response = await harness.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        cookies: cookie,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          provider: { apiKeyConfigured: false },
          capabilities: {
            canSubmitTurn: false,
            submitTurnBlockedReason: 'provider_unavailable',
          },
        },
      });
    } finally {
      await harness.server.close();
    }
  });

  it('serves and updates Provider settings through the shared config service', async () => {
    const harness = await startTestWebServer();
    try {
      const cookie = await harness.bootstrap();
      const current = await harness.inject({
        method: 'GET',
        url: '/api/v1/provider',
        cookies: cookie,
      });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({
        data: {
          baseUrl: 'https://provider.example/v1',
          defaultModel: 'fake-model',
          apiKeyConfigured: true,
        },
      });

      const updated = await harness.inject({
        method: 'PUT',
        url: '/api/v1/provider',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': 'req_provider_update1',
        },
        cookies: cookie,
        payload: {
          baseUrl: 'https://provider.example/v2',
          catalog: { source: 'manual', models: ['model-next'] },
          defaultModel: 'model-next',
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        data: {
          baseUrl: 'https://provider.example/v2',
          catalog: { source: 'manual', models: ['model-next'] },
          defaultModel: 'model-next',
        },
      });

      const replay = await harness.inject({
        method: 'PUT',
        url: '/api/v1/provider',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': 'req_provider_update1',
        },
        cookies: cookie,
        payload: {
          baseUrl: 'https://provider.example/v2',
          catalog: { source: 'manual', models: ['model-next'] },
          defaultModel: 'model-next',
        },
      });
      expect(replay.body).toBe(updated.body);
    } finally {
      await harness.server.close();
    }
  });

  it('projects completed Session events through Trace list and detail routes', async () => {
    const harness = await startSessionApiHarness();
    try {
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('tracecreate1'),
        },
        payload: {},
      });
      const sessionId = (created.json() as { data: { session: { id: string } } }).data.session.id;
      const submitted = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/turns`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('traceturn01'),
        },
        payload: { text: 'produce trace facts' },
      });
      expect(submitted.statusCode).toBe(202);
      await vi.waitFor(
        async () => {
          expect((await harness.service.getSession(sessionId)).turns.at(-1)?.status).toBe(
            'completed',
          );
        },
        { timeout: 2_000 },
      );

      const page = await harness.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/trace?after=0&limit=200`,
      });
      expect(page.statusCode).toBe(200);
      const records = (page.json() as { data: { items: readonly { id: string; type: string }[] } })
        .data.items;
      expect(records.some((record) => record.type === 'user')).toBe(true);
      expect(records.some((record) => record.type === 'turn')).toBe(true);
      const recordId = records.find((record) => record.type === 'turn')?.id;
      expect(recordId).toBeDefined();

      const detail = await harness.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/trace/${encodeURIComponent(recordId ?? '')}`,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        data: { id: recordId, type: 'turn', sections: expect.any(Array) },
      });
    } finally {
      await harness.close();
    }
  });
});
