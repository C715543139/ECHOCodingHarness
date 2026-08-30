import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('smoke-web-artifact source contract', () => {
  it('starts the packaged CLI from a temp cwd and never prints secrets', async () => {
    const source = await fs.readFile(path.join(ROOT, 'scripts', 'smoke-web-artifact.mjs'), 'utf8');

    expect(source).toContain('dist/cli.js');
    expect(source).toContain('dist/web/index.html');
    expect(source).toContain('--no-open');
    expect(source).toContain('127.0.0.1');
    expect(source).toContain('/api/v1/auth/bootstrap');
    expect(source).toContain('/api/v1/bootstrap');
    expect(source).toContain('HttpOnly');
    expect(source).toContain('SameSite=Strict');
    expect(source).toContain('stdin.end');
    expect(source).toContain('Web artifact smoke check passed.');
    expect(source).not.toContain('.env.test');
    expect(source).not.toContain('C:\\\\Users\\\\');
  });
});
