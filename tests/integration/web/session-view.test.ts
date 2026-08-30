import { afterEach, describe, expect, it } from 'vitest';

import { cleanupSessionApiHarnesses, startSessionApiHarness } from './session-api-harness.js';

afterEach(async () => {
  await cleanupSessionApiHarnesses();
});

describe('Session view API', () => {
  it('creates, lists, restores, and pages sessions without accepting workspace paths', async () => {
    const harness = await startSessionApiHarness();
    try {
      const unauthorized = await harness.inject({
        method: 'GET',
        url: '/api/v1/sessions',
        cookies: false,
      });
      expect(unauthorized.statusCode).toBe(401);

      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000001'),
        },
        payload: {},
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      const createdBody = created.json() as {
        data: { session: { id: string; phase: string; title: string }; capabilities: object };
      };
      expect(createdBody.data.session.phase).toBe('idle');
      expect(createdBody.data.capabilities).toMatchObject({
        canCreateSession: true,
        canSubmitTurn: true,
        canChangeRuntime: true,
      });
      expect(JSON.stringify(created.json())).not.toMatch(/C:\\|ECHO_API_KEY|test-key/u);

      const listed = await harness.inject({ method: 'GET', url: '/api/v1/sessions?limit=30' });
      expect(listed.statusCode).toBe(200);
      const listBody = listed.json() as { data: { items: { id: string }[] } };
      expect(listBody.data.items).toHaveLength(1);
      expect(listBody.data.items[0]?.id).toBe(createdBody.data.session.id);

      const restored = await harness.inject({
        method: 'GET',
        url: `/api/v1/sessions/${createdBody.data.session.id}`,
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({
        data: { session: { id: createdBody.data.session.id, phase: 'idle' } },
      });

      const pathRejected = await harness.inject({
        method: 'GET',
        url: '/api/v1/sessions?workspace=C:\\Users\\alice',
      });
      expect(pathRejected.statusCode).toBe(400);
      expect(pathRejected.json()).toMatchObject({ error: { code: 'WORKSPACE_MISMATCH' } });

      const missing = await harness.inject({
        method: 'GET',
        url: '/api/v1/sessions/session-does-not-exist',
      });
      expect(missing.statusCode).toBe(404);

      const second = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000002'),
        },
        payload: { model: 'fake-model', safetyMode: 'safe' },
      });
      expect(second.statusCode).toBe(201);
      const page = await harness.inject({ method: 'GET', url: '/api/v1/sessions?limit=1' });
      expect(page.statusCode).toBe(200);
      const pageBody = page.json() as { data: { items: unknown[]; nextCursor?: string } };
      expect(pageBody.data.items).toHaveLength(1);
      expect(pageBody.data.nextCursor).toBeDefined();
      const next = await harness.inject({
        method: 'GET',
        url: `/api/v1/sessions?limit=1&cursor=${pageBody.data.nextCursor ?? ''}`,
      });
      expect(next.statusCode).toBe(200);
      expect((next.json() as { data: { items: unknown[] } }).data.items).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('updates session runtime when no turn is active', async () => {
    const harness = await startSessionApiHarness();
    try {
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000003'),
        },
        payload: {},
      });
      const sessionId = (created.json() as { data: { session: { id: string } } }).data.session.id;
      const updated = await harness.inject({
        method: 'PATCH',
        url: `/api/v1/sessions/${sessionId}/runtime`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('runtime00001'),
        },
        payload: { safetyMode: 'safe' },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        data: { session: { safetyMode: 'safe' } },
      });

      const empty = await harness.inject({
        method: 'PATCH',
        url: `/api/v1/sessions/${sessionId}/runtime`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('runtime00002'),
        },
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
    } finally {
      await harness.close();
    }
  });
});
