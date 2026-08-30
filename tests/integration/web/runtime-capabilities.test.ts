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

describe('Runtime capability projection', () => {
  it('matches the idle, active-session, other-session, and stopping tables', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await startSessionApiHarness({
      provider: new GatedProvider(
        new FakeProvider([
          {
            events: [
              { type: 'text_delta', delta: 'done' },
              { type: 'completed', finishReason: 'stop' },
            ],
          },
        ]),
        gate,
      ),
    });
    try {
      const first = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000050'),
        },
        payload: {},
      });
      const second = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000051'),
        },
        payload: {},
      });
      const sessionA = (first.json() as { data: { session: { id: string } } }).data.session.id;
      const sessionB = (second.json() as { data: { session: { id: string } } }).data.session.id;

      expect(first.json()).toMatchObject({
        data: {
          capabilities: {
            canCreateSession: true,
            canSubmitTurn: true,
            canChangeRuntime: true,
            canCancelTurn: false,
            canRespondToApproval: false,
          },
        },
      });

      const turn = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionA}/turns`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('turn00000050'),
        },
        payload: { text: 'hold the turn' },
      });
      expect(turn.statusCode).toBe(202);

      const active = await harness.inject({ method: 'GET', url: `/api/v1/sessions/${sessionA}` });
      expect(active.json()).toMatchObject({
        data: {
          capabilities: {
            canCreateSession: true,
            canSubmitTurn: false,
            canChangeRuntime: false,
            canCancelTurn: true,
            submitTurnBlockedReason: 'turn_active',
            activeSessionId: sessionA,
          },
        },
      });

      const other = await harness.inject({ method: 'GET', url: `/api/v1/sessions/${sessionB}` });
      expect(other.json()).toMatchObject({
        data: {
          capabilities: {
            canCreateSession: true,
            canSubmitTurn: false,
            canChangeRuntime: false,
            canCancelTurn: false,
            canRespondToApproval: false,
            submitTurnBlockedReason: 'turn_active',
          },
        },
      });

      harness.beginStop();
      const stopping = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionB}/turns`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('turn00000051'),
        },
        payload: { text: 'should fail' },
      });
      expect(stopping.statusCode).toBe(400);
      const stoppingView = await harness.inject({
        method: 'GET',
        url: `/api/v1/sessions/${sessionB}`,
      });
      expect(stoppingView.json()).toMatchObject({
        data: {
          capabilities: {
            canCreateSession: false,
            canSubmitTurn: false,
            canChangeRuntime: false,
            createSessionBlockedReason: 'service_stopping',
          },
        },
      });
    } finally {
      release();
      await harness.close();
    }
  });
});
