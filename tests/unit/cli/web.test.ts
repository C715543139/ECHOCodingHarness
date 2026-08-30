import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createCli } from '../../../src/cli/create-cli.js';
import { WEB_OPEN_ERROR_CODES } from '../../../src/cli/open-loopback-url.js';
import { runWeb } from '../../../src/cli/web.js';
import {
  WEB_ASSET_SUBDIRECTORY,
  type CreateWebServerOptions,
  type StartedWebServer,
} from '../../../src/web/server/index.js';

const TOKEN = 'b'.repeat(64);
const PORT = 4317;
const BOOTSTRAP_URL = `http://127.0.0.1:${String(PORT)}/#bootstrap=${TOKEN}`;

function fakeServer(
  overrides: {
    readonly bootstrapUrl?: string;
  } = {},
): StartedWebServer & { readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    host: '127.0.0.1',
    port: PORT,
    bootstrapToken: TOKEN,
    bootstrapUrl: overrides.bootstrapUrl ?? BOOTSTRAP_URL,
    app: {} as never,
    close,
  };
}

describe('Web CLI launch contract', () => {
  it('passes artifactRoot/web into the server factory', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'echo-web-cli-ws-'));
    const artifactRoot = path.join(tmpdir(), 'echo-artifact-dist');
    const captured: CreateWebServerOptions[] = [];
    const controller = new AbortController();
    const server = fakeServer();

    const outcome = await runWeb({
      workspace,
      artifactRoot,
      port: 0,
      open: false,
      signal: controller.signal,
      createServer: async (options) => {
        captured.push(options);
        controller.abort();
        return server;
      },
    });

    expect(outcome).toEqual({ exitCode: 0 });
    expect(captured[0]?.assetRoot).toBe(path.join(artifactRoot, WEB_ASSET_SUBDIRECTORY));
  });

  it('opens the exact verified bootstrap URL once in default mode', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'echo-web-cli-open-'));
    const opened: string[] = [];
    const controller = new AbortController();
    const server = fakeServer();

    const outcome = await runWeb({
      workspace,
      artifactRoot: path.join(tmpdir(), 'echo-artifact-dist'),
      signal: controller.signal,
      createServer: async () => {
        controller.abort();
        return server;
      },
      openUrl: async (url) => {
        opened.push(url);
      },
      writeOutput: () => undefined,
    });

    expect(outcome).toEqual({ exitCode: 0 });
    expect(opened).toEqual([BOOTSTRAP_URL]);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('prints the exact URL and never calls the opener with --no-open', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'echo-web-cli-no-open-'));
    const opened = vi.fn();
    const written: string[] = [];
    const controller = new AbortController();
    const server = fakeServer();

    const outcome = await runWeb({
      workspace,
      artifactRoot: path.join(tmpdir(), 'echo-artifact-dist'),
      open: false,
      signal: controller.signal,
      createServer: async () => {
        controller.abort();
        return server;
      },
      openUrl: opened,
      writeOutput: (text) => {
        written.push(text);
      },
    });

    expect(outcome).toEqual({ exitCode: 0 });
    expect(opened).not.toHaveBeenCalled();
    expect(written).toEqual([`${BOOTSTRAP_URL}\n`]);
  });

  it('rejects a non-loopback URL, closes the server, and hides the token', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'echo-web-cli-bad-url-'));
    const opened = vi.fn();
    const errors: string[] = [];
    const server = fakeServer({
      bootstrapUrl: `http://localhost:${String(PORT)}/#bootstrap=${TOKEN}`,
    });

    const outcome = await runWeb({
      workspace,
      artifactRoot: path.join(tmpdir(), 'echo-artifact-dist'),
      signal: new AbortController().signal,
      createServer: async () => server,
      openUrl: opened,
      writeError: (text) => {
        errors.push(text);
      },
    });

    expect(outcome).toEqual({
      exitCode: 2,
      errorCode: WEB_OPEN_ERROR_CODES.invalidUrl,
    });
    expect(opened).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(errors.join('')).toContain('invalid loopback bootstrap URL');
    expect(errors.join('')).not.toContain(TOKEN);
    expect(errors.join('')).not.toContain('localhost');
  });

  it('closes the server with a stable failure when the opener fails', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'echo-web-cli-open-fail-'));
    const errors: string[] = [];
    const server = fakeServer();

    const outcome = await runWeb({
      workspace,
      artifactRoot: path.join(tmpdir(), 'echo-artifact-dist'),
      signal: new AbortController().signal,
      createServer: async () => server,
      openUrl: async () => {
        throw new Error('browser missing');
      },
      writeError: (text) => {
        errors.push(text);
      },
    });

    expect(outcome).toEqual({
      exitCode: 1,
      errorCode: WEB_OPEN_ERROR_CODES.openFailed,
    });
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(errors.join('')).toContain('could not open the local browser');
    expect(errors.join('')).not.toContain(TOKEN);
    expect(errors.join('')).not.toContain('browser missing');
  });

  it('forwards open=false from --no-open without embedding HTTP routes', async () => {
    const artifactRoot = path.join(tmpdir(), 'echo-cli-dist');
    const webAction = vi.fn().mockResolvedValue({ exitCode: 0 });
    let exitCode: number | undefined;
    const cli = createCli({
      artifactRoot,
      webAction,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    await cli.parseAsync(['node', 'echo-harness', 'web', '--no-open']);

    expect(webAction).toHaveBeenCalledWith(expect.objectContaining({ artifactRoot, open: false }));
    expect(exitCode).toBe(0);
  });

  it('forwards open=true from the default web command', async () => {
    const artifactRoot = path.join(tmpdir(), 'echo-cli-dist-open');
    const webAction = vi.fn().mockResolvedValue({ exitCode: 0 });
    const cli = createCli({
      artifactRoot,
      webAction,
      setExitCode: () => undefined,
    });

    await cli.parseAsync(['node', 'echo-harness', 'web']);

    expect(webAction).toHaveBeenCalledWith(expect.objectContaining({ open: true }));
  });
});
