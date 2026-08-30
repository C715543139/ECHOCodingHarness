import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createCli } from '../../../src/cli/create-cli.js';
import { runWeb } from '../../../src/cli/web.js';
import {
  WEB_ASSET_SUBDIRECTORY,
  type CreateWebServerOptions,
} from '../../../src/web/server/index.js';

describe('Web CLI asset root', () => {
  it('passes artifactRoot/web into the server factory and prints the bootstrap URL', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'echo-web-cli-ws-'));
    const artifactRoot = path.join(tmpdir(), 'echo-artifact-dist');
    const captured: CreateWebServerOptions[] = [];
    const written: string[] = [];
    const controller = new AbortController();

    const outcome = await runWeb({
      workspace,
      artifactRoot,
      port: 0,
      signal: controller.signal,
      createServer: async (options) => {
        captured.push(options);
        controller.abort();
        return {
          host: '127.0.0.1',
          port: 4317,
          bootstrapToken: 'token',
          bootstrapUrl: 'http://127.0.0.1:4317/#bootstrap=token',
          app: {} as never,
          close: vi.fn().mockResolvedValue(undefined),
        };
      },
      writeOutput: (text) => {
        written.push(text);
      },
    });

    expect(outcome).toEqual({ exitCode: 0 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.artifactRoot).toBe(artifactRoot);
    expect(captured[0]?.assetRoot).toBe(path.join(artifactRoot, WEB_ASSET_SUBDIRECTORY));
    expect(captured[0]?.assetRoot).not.toBe(
      path.join(path.dirname(artifactRoot), WEB_ASSET_SUBDIRECTORY),
    );
    expect(written).toEqual(['http://127.0.0.1:4317/#bootstrap=token\n']);
  });

  it('forwards the CLI artifactRoot to runWeb so the adapter can resolve X/web', async () => {
    const artifactRoot = path.join(tmpdir(), 'echo-cli-dist');
    const webAction = vi.fn().mockImplementation(async (options: { artifactRoot: string }) => {
      expect(path.join(options.artifactRoot, WEB_ASSET_SUBDIRECTORY)).toBe(
        path.join(artifactRoot, 'web'),
      );
      return { exitCode: 0 };
    });
    let exitCode: number | undefined;
    const cli = createCli({
      artifactRoot,
      webAction,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    await cli.parseAsync(['node', 'echo-harness', 'web', '--no-open']);

    expect(webAction).toHaveBeenCalledWith(expect.objectContaining({ artifactRoot }));
    expect(exitCode).toBe(0);
  });
});
