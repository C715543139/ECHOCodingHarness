import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Phase A web assembly', () => {
  it('registers production routes and transport while keeping dist/web intact', async () => {
    const [server, routes, main, tsup, pack] = await Promise.all([
      readFile(path.join(ROOT, 'src/web/server/create-web-server.ts'), 'utf8'),
      readFile(path.join(ROOT, 'src/web/server/register-routes.ts'), 'utf8'),
      readFile(path.join(ROOT, 'src/web/client/main.tsx'), 'utf8'),
      readFile(path.join(ROOT, 'tsup.config.ts'), 'utf8'),
      readFile(path.join(ROOT, 'package.json'), 'utf8'),
    ]);

    expect(server).toContain('registerWebRoutes');
    expect(routes).toContain("app.post('/api/v1/auth/bootstrap'");
    expect(routes).toContain("app.get('/api/v1/bootstrap'");
    expect(routes).toContain('registerSessionApiRoutes');
    expect(routes).toContain('registerProviderApiRoutes');
    expect(routes).toContain('registerExtensionApiRoutes');
    expect(routes).not.toContain('/export');
    expect(main).toContain('createHttpTransport');
    expect(main).not.toContain('createFakeTransport');
    expect(tsup).toContain('clean: false');
    expect(tsup).toContain('dist/web');
    expect(pack).toContain('clean-node-dist.mjs');
    expect(pack).toContain('smoke:web-artifact');
  });
});
