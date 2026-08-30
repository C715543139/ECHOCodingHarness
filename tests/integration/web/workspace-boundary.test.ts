import { describe, expect, it } from 'vitest';

import { WEB_JSON_SCHEMAS, validateWebJsonSchema } from '../../../src/contracts/web-schema.js';

import { startTestWebServer } from './harness.js';

describe('Web workspace boundary', () => {
  it('returns a basename workspace summary and rejects path fields', async () => {
    const harness = await startTestWebServer();
    try {
      const cookie = await harness.bootstrap();
      const bootstrap = await harness.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        cookies: cookie,
      });
      expect(bootstrap.statusCode).toBe(200);
      const body = bootstrap.json() as {
        data: { workspace: { name: string; fingerprint: string } };
      };
      expect(body.data.workspace.name).not.toMatch(/[\\/:]/u);
      expect(JSON.stringify(body)).not.toContain(harness.workspaceRoot);
      expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.bootstrap, body.data)).toEqual([]);

      const query = await harness.inject({
        method: 'GET',
        url: '/api/v1/bootstrap?workspace=C:%5CUsers%5Cfixture%5Crepo',
        cookies: cookie,
      });
      expect(query.statusCode).toBe(400);
      expect(query.json()).toMatchObject({ error: { code: 'WORKSPACE_MISMATCH' } });

      const posted = await harness.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: { origin: harness.origin, 'content-type': 'application/json' },
        payload: { token: 'unused-token-value', workspace: '/home/fixture/repo' },
      });
      expect(posted.statusCode).toBe(400);
      expect(posted.json()).toMatchObject({ error: { code: 'WORKSPACE_MISMATCH' } });
    } finally {
      await harness.server.close();
    }
  });
});
