import { afterEach, describe, expect, it } from 'vitest';

import type { EchoEvent } from '../../../src/contracts/index.js';
import { FakeProvider } from '../../../src/provider/index.js';

import {
  GatedProvider,
  askPolicy,
  cleanupSessionApiHarnesses,
  inspectTool,
  startSessionApiHarness,
} from './session-api-harness.js';

afterEach(async () => {
  await cleanupSessionApiHarnesses();
});

describe('Turn, cancel, and approval API', () => {
  it('rejects blank turns, enforces one active turn, and cancels the running turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new GatedProvider(
      new FakeProvider([
        {
          events: [
            { type: 'text_delta', delta: 'done' },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
        {
          events: [
            { type: 'text_delta', delta: 'second' },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
      ]),
      gate,
    );
    const harness = await startSessionApiHarness({ provider });
    try {
      const first = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000010'),
        },
        payload: {},
      });
      const second = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000011'),
        },
        payload: {},
      });
      const sessionA = (first.json() as { data: { session: { id: string } } }).data.session.id;
      const sessionB = (second.json() as { data: { session: { id: string } } }).data.session.id;

      const blank = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionA}/turns`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('turn00000001'),
        },
        payload: { text: '   ' },
      });
      expect(blank.statusCode).toBe(400);

      const racing = Promise.all([
        harness.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionA}/turns`,
          headers: {
            origin: harness.origin,
            'content-type': 'application/json',
            'x-echo-request-id': harness.requestId('turn00000002'),
          },
          payload: { text: 'first goal' },
        }),
        harness.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionB}/turns`,
          headers: {
            origin: harness.origin,
            'content-type': 'application/json',
            'x-echo-request-id': harness.requestId('turn00000003'),
          },
          payload: { text: 'second goal' },
        }),
      ]);
      const [one, two] = await racing;
      const statuses = [one.statusCode, two.statusCode].toSorted();
      expect(statuses).toEqual([202, 409]);
      const accepted = one.statusCode === 202 ? one : two;
      const rejected = one.statusCode === 409 ? one : two;
      const acceptedBody = accepted.json() as { data: { sessionId: string; turnId: string } };
      expect(rejected.json()).toMatchObject({
        error: {
          code: 'TURN_ACTIVE',
          fields: { activeSessionId: acceptedBody.data.sessionId },
        },
      });
      const sessionId = acceptedBody.data.sessionId;
      const turnId = acceptedBody.data.turnId;
      const otherSession = sessionId === sessionA ? sessionB : sessionA;

      const runtime = await harness.inject({
        method: 'PATCH',
        url: `/api/v1/sessions/${otherSession}/runtime`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('runtime00010'),
        },
        payload: { model: 'fake-model' },
      });
      expect(runtime.statusCode).toBe(409);
      expect(runtime.json()).toMatchObject({ error: { code: 'TURN_ACTIVE' } });

      const viewB = await harness.inject({
        method: 'GET',
        url: `/api/v1/sessions/${otherSession}`,
      });
      expect(viewB.statusCode).toBe(200);
      expect(viewB.json()).toMatchObject({
        data: {
          capabilities: {
            canSubmitTurn: false,
            canCancelTurn: false,
            canCreateSession: true,
          },
        },
      });

      const cancel = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/turns/${turnId}/cancel`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('cancel000001'),
        },
        payload: {},
      });
      expect(cancel.statusCode).toBe(202);
      expect(cancel.json()).toMatchObject({
        data: { sessionId, turnId, state: 'cancelling' },
      });
      release();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      const cancelAgain = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/turns/${turnId}/cancel`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('cancel000002'),
        },
        payload: {},
      });
      expect(cancelAgain.statusCode).toBe(409);
      expect(cancelAgain.json()).toMatchObject({ error: { code: 'TURN_NOT_ACTIVE' } });
    } finally {
      release();
      await harness.close();
    }
  });

  it('accepts a bound approval once and rejects duplicate or unknown keys', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: { path: 'a' } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'finished' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const harness = await startSessionApiHarness({
      provider,
      policy: askPolicy,
      tools: [inspectTool()],
    });
    try {
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000020'),
        },
        payload: {},
      });
      const sessionId = (created.json() as { data: { session: { id: string } } }).data.session.id;
      const requested = new Promise<Extract<EchoEvent, { type: 'approval.requested' }>>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error('timed out waiting for approval.requested'));
          }, 8_000);
          const unsubscribe = harness.hub.subscribe(sessionId, (event) => {
            if (event.type !== 'approval.requested') return;
            clearTimeout(timeout);
            unsubscribe();
            resolve(event);
          });
        },
      );
      const turn = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/turns`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('turn00000020'),
        },
        payload: { text: 'inspect the fixture' },
      });
      expect(turn.statusCode).toBe(202);
      const turnId = (turn.json() as { data: { turnId: string } }).data.turnId;
      expect((await requested).payload.toolCallId).toBe('call-1');

      let pending: { approvalKey: string; toolCallId: string } | undefined;
      let lastView: { statusCode: number; body: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && pending === undefined; attempt += 1) {
        const view = await harness.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}` });
        lastView = { statusCode: view.statusCode, body: view.json() };
        const approval = (
          lastView.body as {
            data?: { session?: { pendingApproval?: { approvalKey: string; toolCallId: string } } };
          }
        ).data?.session?.pendingApproval;
        if (approval !== undefined) pending = approval;
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lastView?.statusCode, JSON.stringify(lastView)).toBe(200);
      expect(pending, JSON.stringify(lastView)).toBeDefined();
      if (pending === undefined) throw new Error('expected pending approval');

      const accepted = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/approvals/${pending.approvalKey}`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('approve00001'),
        },
        payload: {
          turnId,
          toolCallId: pending.toolCallId,
          decision: 'allow_once',
        },
      });
      expect(accepted.statusCode).toBe(202);

      const duplicate = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/approvals/${pending.approvalKey}`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('approve00002'),
        },
        payload: {
          turnId,
          toolCallId: pending.toolCallId,
          decision: 'allow_session',
        },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ error: { code: 'APPROVAL_DUPLICATE' } });

      const unknown = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/approvals/missing-key`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('approve00003'),
        },
        payload: {
          turnId,
          toolCallId: 'call-missing',
          decision: 'deny',
        },
      });
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json()).toMatchObject({ error: { code: 'APPROVAL_NOT_PENDING' } });
    } finally {
      await harness.close();
    }
  });
});
