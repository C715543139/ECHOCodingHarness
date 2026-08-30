import { afterEach, describe, expect, it } from 'vitest';

import { cleanupSessionApiHarnesses, startSessionApiHarness } from './session-api-harness.js';

afterEach(async () => {
  await cleanupSessionApiHarnesses();
});

describe('Session API idempotency', () => {
  it('replays the first turn, cancel, and approval responses and conflicts on a different fingerprint', async () => {
    const harness = await startSessionApiHarness();
    try {
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000030'),
        },
        payload: {},
      });
      const sessionId = (created.json() as { data: { session: { id: string } } }).data.session.id;
      const replayCreate = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000030'),
        },
        payload: {},
      });
      expect(replayCreate.statusCode).toBe(201);
      expect(replayCreate.json()).toEqual(created.json());
      const listed = await harness.inject({ method: 'GET', url: '/api/v1/sessions' });
      expect((listed.json() as { data: { items: unknown[] } }).data.items).toHaveLength(1);

      const conflict = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000030'),
        },
        payload: { safetyMode: 'safe' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });

      const turn = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/turns`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('turn00000030'),
        },
        payload: { text: 'finish quickly' },
      });
      expect(turn.statusCode).toBe(202);
      const replayTurn = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/turns`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('turn00000030'),
        },
        payload: { text: 'finish quickly' },
      });
      expect(replayTurn.statusCode).toBe(202);
      expect(replayTurn.json()).toEqual(turn.json());
      const after = await harness.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}` });
      expect(after.json()).toMatchObject({ data: { session: { turnCount: 1 } } });
    } finally {
      await harness.close();
    }
  });
});
