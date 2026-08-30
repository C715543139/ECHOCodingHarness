import http from 'node:http';

import { describe, expect, it } from 'vitest';

import { WEB_AUTH_COOKIE } from '../../../src/web/server/index.js';

import { startTestWebServer } from './harness.js';

function openSse(
  url: string,
  cookie: string,
): Promise<{
  readonly request: http.ClientRequest;
  readonly status: number;
  readonly text: string;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: {
          host: parsed.host,
          cookie: `${WEB_AUTH_COOKIE}=${cookie}`,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          resolve({ request, status, text: '' });
          return;
        }
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('event: heartbeat')) {
            resolve({ request, status, text });
          }
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function openSseAfterRelease(
  url: string,
  cookie: string,
): Promise<Awaited<ReturnType<typeof openSse>>> {
  // The server releases ownership when it observes the socket close, which can
  // lag behind the client-side close event.
  const deadline = Date.now() + 2000;
  for (;;) {
    const attempt = await openSse(url, cookie);
    if (attempt.status !== 409 || Date.now() >= deadline) return attempt;
    attempt.request.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('Web SSE ownership', () => {
  it('allows one stream per process cookie and heartbeats without an id', async () => {
    const harness = await startTestWebServer({ heartbeatIntervalMs: 15 });
    try {
      const cookie = await harness.bootstrap();
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: {
          origin: harness.origin,
          'content-type': 'application/json',
          'x-echo-request-id': 'req_sse_owner_create',
        },
        cookies: cookie,
        payload: {},
      });
      expect(created.statusCode).toBe(201);
      const sessionId = (created.json() as { data: { session: { id: string } } }).data.session.id;
      const url = `${harness.origin}/api/v1/sessions/${sessionId}/events`;
      const firstPromise = openSse(url, cookie);
      const secondPromise = openSse(url, cookie);
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      const statuses = [first.status, second.status].toSorted((left, right) => left - right);
      expect(statuses).toEqual([200, 409]);
      const winner = first.status === 200 ? first : second;
      const loser = first.status === 409 ? first : second;
      expect(winner.text).toContain('event: heartbeat');
      expect(winner.text).not.toMatch(/id:[^\n]*\nevent: heartbeat/u);
      expect(loser.status).toBe(409);

      winner.request.destroy();
      await new Promise<void>((resolve) => {
        winner.request.once('close', () => resolve());
      });

      const reconnect = await openSseAfterRelease(url, cookie);
      expect(reconnect.status).toBe(200);
      expect(reconnect.text).toContain('event: heartbeat');
      expect(reconnect.text).not.toMatch(/id:[^\n]*\nevent: heartbeat/u);
      reconnect.request.destroy();
    } finally {
      await harness.server.close();
    }
  });
});
