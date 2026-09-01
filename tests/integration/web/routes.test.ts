import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { startTestWebServer } from './harness.js';

describe('Web route assembly', () => {
  it('serves the packaged shell and does not register a session export route', async () => {
    const harness = await startTestWebServer({ withAssets: true });
    try {
      const cookie = await harness.bootstrap();
      await writeFile(
        path.join(harness.artifactRoot, 'web-assets', 'index.html'),
        '<!doctype html><title>changed after startup</title>',
      );
      const page = await harness.inject({ method: 'GET', url: '/' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<title>echo</title>');
      expect(page.body).not.toContain('changed after startup');

      const exported = await harness.inject({
        method: 'GET',
        url: '/api/v1/sessions/session-1/export',
        cookies: cookie,
      });
      expect(exported.statusCode).toBe(404);
      expect(exported.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(JSON.stringify(exported.json())).not.toMatch(/export|download/iu);
    } finally {
      await harness.server.close();
    }
  });
});
