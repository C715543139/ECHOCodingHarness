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

describe('Web SSE ownership', () => {
  it('allows one stream per process cookie and heartbeats without an id', async () => {
    const harness = await startTestWebServer({ heartbeatIntervalMs: 15 });
    try {
      const cookie = await harness.bootstrap();
      const url = `${harness.origin}/api/v1/sessions/session-1/events`;
      const first = await openSse(url, cookie);
      expect(first.status).toBe(200);
      expect(first.text).toContain('event: heartbeat');
      expect(first.text).not.toMatch(/^id:/mu);

      const conflict = await fetch(url, { headers: { cookie: `${WEB_AUTH_COOKIE}=${cookie}` } });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: 'STREAM_ACTIVE' } });

      first.request.destroy();
      await new Promise<void>((resolve) => {
        first.request.once('close', () => resolve());
      });

      const second = await openSse(url, cookie);
      expect(second.status).toBe(200);
      expect(second.text).toContain('event: heartbeat');
      expect(second.text).not.toMatch(/^id:/mu);
      second.request.destroy();
    } finally {
      await harness.server.close();
    }
  });
});
