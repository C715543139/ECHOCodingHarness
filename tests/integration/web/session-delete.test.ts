import { afterEach, describe, expect, it } from 'vitest';

import { FakeProvider } from '../../../src/provider/index.js';

import {
  GatedProvider,
  cleanupSessionApiHarnesses,
  startSessionApiHarness,
} from './session-api-harness.js';

afterEach(async () => {
  await cleanupSessionApiHarnesses();
});

function mutationHeaders(origin: string, requestId: string): Record<string, string> {
  return {
    origin,
    'content-type': 'application/json',
    'x-echo-request-id': requestId,
  };
}

describe('Session deletion API', () => {
  it('confirms an idle session deletion through the API and keeps other sessions intact', async () => {
    const harness = await startSessionApiHarness();
    try {
      const first = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: mutationHeaders(harness.origin, harness.requestId('delcreate001')),
        payload: {},
      });
      const second = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: mutationHeaders(harness.origin, harness.requestId('delcreate002')),
        payload: {},
      });
      const firstId = (first.json() as { data: { session: { id: string } } }).data.session.id;
      const secondId = (second.json() as { data: { session: { id: string } } }).data.session.id;

      const deleted = await harness.inject({
        method: 'DELETE',
        url: `/api/v1/sessions/${firstId}`,
        headers: mutationHeaders(harness.origin, harness.requestId('deleteidle01')),
        payload: {},
      });

      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({
        data: { sessionId: firstId, stoppedActiveTurn: false },
      });
      const replayed = await harness.inject({
        method: 'DELETE',
        url: `/api/v1/sessions/${firstId}`,
        headers: mutationHeaders(harness.origin, harness.requestId('deleteidle01')),
        payload: {},
      });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.body).toBe(deleted.body);
      expect(
        (await harness.inject({ method: 'GET', url: `/api/v1/sessions/${firstId}` })).statusCode,
      ).toBe(404);
      expect(
        (await harness.inject({ method: 'GET', url: `/api/v1/sessions/${secondId}` })).statusCode,
      ).toBe(200);

      const repeated = await harness.inject({
        method: 'DELETE',
        url: `/api/v1/sessions/${firstId}`,
        headers: mutationHeaders(harness.origin, harness.requestId('deleteidle02')),
        payload: {},
      });
      expect(repeated.statusCode).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it('cancels and settles an active turn before deleting its session', async () => {
    const provider = new GatedProvider(
      new FakeProvider([
        {
          events: [
            { type: 'text_delta', delta: 'done' },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
      ]),
      new Promise<void>(() => undefined),
    );
    const harness = await startSessionApiHarness({ provider });
    try {
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: mutationHeaders(harness.origin, harness.requestId('deleteactive1')),
        payload: {},
      });
      const sessionId = (created.json() as { data: { session: { id: string } } }).data.session.id;
      const turn = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/turns`,
        headers: mutationHeaders(harness.origin, harness.requestId('deleteactive2')),
        payload: { text: 'wait for deletion' },
      });
      expect(turn.statusCode).toBe(202);

      const deleted = await harness.inject({
        method: 'DELETE',
        url: `/api/v1/sessions/${sessionId}`,
        headers: mutationHeaders(harness.origin, harness.requestId('deleteactive3')),
        payload: {},
      });

      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({
        data: { sessionId, stoppedActiveTurn: true },
      });
      expect(harness.coordinator.snapshot()).toEqual({});
      expect(
        (await harness.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}` })).statusCode,
      ).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
