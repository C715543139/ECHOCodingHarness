import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { WEB_ASSET_SUBDIRECTORY, WEB_SERVER_HOST } from '../../../src/web/server/index.js';

describe('Web build baseline', () => {
  it('keeps the future server loopback-only and the packaged assets under dist', () => {
    expect(WEB_SERVER_HOST).toBe('127.0.0.1');
    expect(WEB_ASSET_SUBDIRECTORY).toBe('web');
  });

  it('packages build outputs without workspace runtime state', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { files?: string[] };

    expect(packageJson.files).toEqual(['dist/*.js', 'dist/*.js.map', 'dist/*.d.ts', 'dist/web']);
  });

  it('pins patched static serving and build tooling versions', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const workspaceConfig = await readFile(
      new URL('../../../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );

    expect(packageJson.dependencies?.['@fastify/static']).toBe('10.1.3');
    expect(workspaceConfig).toMatch(/^overrides:\r?\n {2}esbuild: 0\.28\.2$/mu);
  });
});
