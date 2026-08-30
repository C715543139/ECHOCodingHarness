import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('real Web Provider acceptance entry', () => {
  it('uses the packaged Web API, keeps credentials out of output, and stays outside CI', async () => {
    const [source, pack, ci] = await Promise.all([
      readFile(path.join(ROOT, 'scripts', 'accept-web-provider.mjs'), 'utf8'),
      readFile(path.join(ROOT, 'package.json'), 'utf8'),
      readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    ]);

    expect(source).toContain("'dist', 'cli.js'");
    expect(source).toContain('/api/v1/auth/bootstrap');
    expect(source).toContain('/api/v1/sessions');
    expect(source).toContain('/events?after=0');
    expect(source).toContain('/chat?limit=30');
    expect(source).toContain('/trace?after=0&limit=200');
    expect(source).toContain('assertPrivate');
    expect(source).toContain('restoreConfig');
    expect(source).not.toContain('console.log');
    expect(pack).toContain('"accept:web-provider"');
    expect(ci).not.toContain('accept:web-provider');
    expect(ci).not.toContain('ECHO_API_KEY');
  });
});
