import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Phase A web assembly', () => {
  it('registers Fastify routes in one module and keeps tsup from wiping dist/web', async () => {
    const [server, routes, tsup, pack] = await Promise.all([
      readFile(path.join(ROOT, 'src/web/server/create-web-server.ts'), 'utf8'),
      readFile(path.join(ROOT, 'src/web/server/register-routes.ts'), 'utf8'),
      readFile(path.join(ROOT, 'tsup.config.ts'), 'utf8'),
      readFile(path.join(ROOT, 'package.json'), 'utf8'),
    ]);

    expect(server).toContain('registerWebRoutes');
    expect(routes).toContain("app.post('/api/v1/auth/bootstrap'");
    expect(routes).toContain("app.get('/api/v1/bootstrap'");
    expect(routes).not.toContain('/export');
    expect(tsup).toContain('clean: false');
    expect(tsup).toContain('dist/web');
    expect(pack).toContain('clean-node-dist.mjs');
    expect(pack).toContain('smoke:web-artifact');
  });
});
