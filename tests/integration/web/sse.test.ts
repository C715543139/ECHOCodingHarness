import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { FakeProvider } from '../../../src/provider/index.js';
import { WEB_AUTH_COOKIE } from '../../../src/web/server/index.js';
import { isWebStreamEvent } from '../../../src/contracts/web-schema.js';

import { cleanupSessionApiHarnesses, startSessionApiHarness } from './session-api-harness.js';

afterEach(async () => {
  await cleanupSessionApiHarnesses();
});

interface OpenSse {
  readonly request: http.ClientRequest;
  readonly status: number;
  text(): string;
  waitUntil(predicate: (text: string) => boolean, timeoutMs?: number): Promise<void>;
}

function openSse(url: string, cookie: string): Promise<OpenSse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          host: parsed.host,
          cookie: `${WEB_AUTH_COOKIE}=${cookie}`,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        let text = '';
        const waiters: ((value: string) => void)[] = [];
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
          for (const waiter of waiters.splice(0)) waiter(text);
        });
        response.on('error', reject);
        resolve({
          request,
          status,
          text: () => text,
          waitUntil(predicate, timeoutMs = 5_000) {
            if (predicate(text)) return Promise.resolve();
            return new Promise<void>((done, fail) => {
              const timer = setTimeout(() => {
                fail(new Error(`SSE wait timed out: ${text.slice(0, 500)}`));
              }, timeoutMs);
              const check = (current: string): void => {
                if (!predicate(current)) {
                  waiters.push(check);
                  return;
                }
                clearTimeout(timer);
                done();
              };
              waiters.push(check);
            });
          },
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('Session SSE backlog and live handoff', () => {
  it('replays seqs, streams live terminals, heartbeats without an id, and rejects a second stream', async () => {
    const harness = await startSessionApiHarness({
      provider: new FakeProvider([
        {
          events: [
            { type: 'text_delta', delta: 'live' },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
      ]),
      heartbeatIntervalMs: 15,
    });
    try {
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('create000040'),
        },
        payload: {},
      });
      const sessionId = (created.json() as { data: { session: { id: string } } }).data.session.id;

      const stream = await openSse(
        `${harness.origin}/api/v1/sessions/${sessionId}/events?after=0`,
        harness.cookie,
      );
      expect(stream.status).toBe(200);
      await stream.waitUntil(
        (text) => text.includes('event: heartbeat') && text.includes('event: session.updated'),
      );
      expect(stream.text()).not.toMatch(/^id:.*\nevent: heartbeat/mu);
      expect(stream.text()).toMatch(/^id: 1$/mu);

      const conflict = await fetch(`${harness.origin}/api/v1/sessions/${sessionId}/events`, {
        headers: { cookie: `${WEB_AUTH_COOKIE}=${harness.cookie}` },
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: 'STREAM_ACTIVE' } });

      const turn = await harness.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/turns`,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': harness.requestId('turn00000040'),
        },
        payload: { text: 'stream this turn' },
      });
      expect(turn.statusCode).toBe(202);
      await stream.waitUntil((text) => text.includes('event: turn.terminal'));

      const payloads = [...stream.text().matchAll(/^data: (\{.*\})$/gmu)]
        .map((match) => match[1] ?? '')
        .filter((line) => line !== '{}')
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              seq?: number;
              delta?: {
                view: {
                  session: { phase: string };
                  capabilities: Record<string, unknown>;
                };
              };
            },
        );
      for (const payload of payloads) {
        expect(isWebStreamEvent(payload)).toBe(true);
      }
      const seqs = payloads
        .map((payload) => payload.seq)
        .filter((seq): seq is number => typeof seq === 'number');
      expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
      expect(new Set(seqs).size).toBe(seqs.length);
      const terminal = payloads.find((payload) => payload.type === 'turn.terminal');
      expect(terminal?.delta?.view.session.phase).toBe('completed');
      expect(terminal?.delta?.view.capabilities).toMatchObject({
        canSubmitTurn: true,
        canChangeRuntime: true,
        canCancelTurn: false,
      });
      expect(terminal?.delta?.view.capabilities).not.toHaveProperty('activeSessionId');
      expect(terminal?.delta?.view.capabilities).not.toHaveProperty('activeTurnId');
      expect(terminal?.delta?.view.capabilities).not.toHaveProperty('submitTurnBlockedReason');
      stream.request.destroy();
    } finally {
      await harness.close();
    }
  });
});
