import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionManifest, ToolContext } from '../../../src/contracts/index.js';
import { ExtensionRuntimeManager, ExtensionWorkerHost } from '../../../src/extensions/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function extension(source: string, toolNames: readonly string[] = ['inspect']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-worker-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'index.mjs'), source, 'utf8');
  const manifest: ExtensionManifest = {
    schemaVersion: 1,
    id: 'test-extension',
    version: '1.0.0',
    entry: 'index.mjs',
    selfTest: 'extension.test.mjs',
    tools: toolNames.map((name) => ({
      name,
      description: `Execute ${name}.`,
      inputSchema: { type: 'object', additionalProperties: false },
    })),
  };
  return { root, manifest };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session',
    turnId: 'turn',
    stepId: 'step',
    toolCallId: 'call',
    workspaceRoot: 'C:\\workspace',
    signal: new AbortController().signal,
    limits: { timeoutMs: 500, maxOutputChars: 1_000 },
    ...overrides,
  };
}

describe('ExtensionWorkerHost', () => {
  it('does not inherit parent exec arguments that change eval module semantics', async () => {
    process.execArgv.push('--input-type=module');
    const fixture = await extension(`
      export const handlers = {
        inspect: async () => ({ status: 'completed', summary: 'ok', data: null, truncated: false })
      };
    `);
    try {
      const host = await ExtensionWorkerHost.open({
        extensionId: fixture.manifest.id,
        extensionRoot: fixture.root,
        workspaceRoot: fixture.root,
        manifest: fixture.manifest,
      });
      await expect(host.execute('inspect', {}, context())).resolves.toMatchObject({
        status: 'completed',
      });
      await host.shutdown();
    } finally {
      const index = process.execArgv.lastIndexOf('--input-type=module');
      if (index >= 0) process.execArgv.splice(index, 1);
    }
  });

  it('executes a manifest handler without inheriting credentials', async () => {
    const priorApiKey = process.env['ECHO_API_KEY'];
    const priorSecret = process.env['UNRELATED_SECRET'];
    process.env['ECHO_API_KEY'] = 'must-not-leak';
    process.env['UNRELATED_SECRET'] = 'must-not-leak';
    const fixture = await extension(`
      export const handlers = {
        inspect: async (input, context) => ({
          status: 'completed',
          summary: 'inspected',
          data: {
            input,
            workspaceRoot: context.workspaceRoot,
            hasApiKey: 'ECHO_API_KEY' in process.env,
            hasUnrelatedSecret: 'UNRELATED_SECRET' in process.env
          },
          truncated: false
        })
      };
    `);
    try {
      const host = await ExtensionWorkerHost.open({
        extensionId: fixture.manifest.id,
        extensionRoot: fixture.root,
        workspaceRoot: 'C:\\workspace',
        manifest: fixture.manifest,
      });
      await expect(host.execute('inspect', { ok: true }, context())).resolves.toMatchObject({
        status: 'completed',
        data: {
          input: { ok: true },
          workspaceRoot: 'C:\\workspace',
          hasApiKey: false,
          hasUnrelatedSecret: false,
        },
      });
      await host.shutdown();
    } finally {
      if (priorApiKey === undefined) delete process.env['ECHO_API_KEY'];
      else process.env['ECHO_API_KEY'] = priorApiKey;
      if (priorSecret === undefined) delete process.env['UNRELATED_SECRET'];
      else process.env['UNRELATED_SECRET'] = priorSecret;
    }
  });

  it('bounds oversized results while keeping valid executions reusable', async () => {
    const fixture = await extension(`
      export const handlers = {
        inspect: async () => ({
          status: 'completed', summary: 'x'.repeat(1000), data: { text: 'y'.repeat(2000) }, truncated: false
        })
      };
    `);
    const host = await ExtensionWorkerHost.open({
      extensionId: fixture.manifest.id,
      extensionRoot: fixture.root,
      workspaceRoot: fixture.root,
      manifest: fixture.manifest,
    });

    const result = await host.execute(
      'inspect',
      {},
      context({ limits: { timeoutMs: 500, maxOutputChars: 120 } }),
    );
    expect(result).toMatchObject({ status: 'completed', truncated: true });
    expect(JSON.stringify(result).length).toBeLessThan(500);
    expect(host.closed).toBe(false);
    await host.shutdown();
  });

  it('returns ordinary handler failures without faulting or unloading the worker', async () => {
    const onFault = vi.fn();
    const fixture = await extension(`
      export const handlers = {
        inspect: async (input) => {
          if (input.fail) throw new Error('ordinary failure');
          return { status: 'completed', summary: 'ok', data: null, truncated: false };
        }
      };
    `);
    const host = await ExtensionWorkerHost.open(
      {
        extensionId: fixture.manifest.id,
        extensionRoot: fixture.root,
        workspaceRoot: fixture.root,
        manifest: fixture.manifest,
      },
      { onFault },
    );

    await expect(host.execute('inspect', { fail: true }, context())).resolves.toMatchObject({
      status: 'failed',
      error: { category: 'tool_execution', code: 'EXTENSION_HANDLER_FAILED' },
    });
    await expect(host.execute('inspect', { fail: false }, context())).resolves.toMatchObject({
      status: 'completed',
    });
    expect(host.activeCallCount).toBe(0);
    expect(onFault).not.toHaveBeenCalled();
    await host.shutdown();
  });

  it('treats non-cloneable handler output as a protocol fault', async () => {
    const onFault = vi.fn();
    const fixture = await extension(`
      export const handlers = {
        inspect: async () => ({ status: 'completed', summary: 'bad', data: () => true, truncated: false })
      };
    `);
    const host = await ExtensionWorkerHost.open(
      {
        extensionId: fixture.manifest.id,
        extensionRoot: fixture.root,
        workspaceRoot: fixture.root,
        manifest: fixture.manifest,
      },
      { onFault },
    );

    await expect(host.execute('inspect', {}, context())).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'WORKER_PROTOCOL_ERROR' },
    });
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WORKER_PROTOCOL_ERROR' }),
    );
  });

  it('rejects oversized inputs before posting them to the worker', async () => {
    const fixture = await extension(`
      export const handlers = {
        inspect: async () => ({ status: 'completed', summary: 'ok', data: null, truncated: false })
      };
    `);
    const host = await ExtensionWorkerHost.open({
      extensionId: fixture.manifest.id,
      extensionRoot: fixture.root,
      workspaceRoot: fixture.root,
      manifest: fixture.manifest,
    });

    await expect(
      host.execute('inspect', { text: 'x'.repeat(1024 * 1024) }, context()),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { category: 'invalid_tool_input', code: 'EXTENSION_INPUT_TOO_LARGE' },
    });
    expect(host.closed).toBe(false);
    await host.shutdown();
  });

  it('propagates cancellation and keeps a cooperative worker available', async () => {
    const fixture = await extension(
      `
        export const handlers = {
          wait: async (_input, context) => new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          }),
          ping: async () => ({ status: 'completed', summary: 'pong', data: null, truncated: false })
        };
      `,
      ['wait', 'ping'],
    );
    const host = await ExtensionWorkerHost.open({
      extensionId: fixture.manifest.id,
      extensionRoot: fixture.root,
      workspaceRoot: fixture.root,
      manifest: fixture.manifest,
    });
    const controller = new AbortController();
    const running = host.execute('wait', {}, context({ signal: controller.signal }));
    controller.abort();

    await expect(running).resolves.toMatchObject({
      status: 'failed',
      error: { category: 'cancelled', code: 'EXTENSION_CALL_CANCELLED' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(host.execute('ping', {}, context())).resolves.toMatchObject({
      status: 'completed',
    });
    await host.shutdown();
  });
});

describe('ExtensionRuntimeManager', () => {
  it('removes all registered tools and reports quarantine when a worker crashes', async () => {
    const fixture = await extension(`
      export const handlers = {
        inspect: async () => { process.exit(17); }
      };
    `);
    const registry = new ToolRegistry([]);
    const onQuarantine = vi.fn();
    const manager = new ExtensionRuntimeManager({
      registry,
      workspaceRoot: fixture.root,
      onQuarantine,
    });
    await manager.load(fixture.root, fixture.manifest);
    expect(registry.has('inspect')).toBe(true);

    await expect(registry.execute('inspect', {}, context())).resolves.toMatchObject({
      status: 'failed',
    });
    await vi.waitFor(() => expect(registry.has('inspect')).toBe(false));
    expect(manager.isLoaded(fixture.manifest.id)).toBe(false);
    expect(onQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: fixture.manifest.id, code: 'WORKER_CRASHED' }),
    );
  });

  it('terminates and unregisters a worker that ignores timeout cancellation', async () => {
    const fixture = await extension(`
      export const handlers = { inspect: async () => new Promise(() => {}) };
    `);
    const registry = new ToolRegistry([]);
    const onQuarantine = vi.fn();
    const manager = new ExtensionRuntimeManager({
      registry,
      workspaceRoot: fixture.root,
      onQuarantine,
      workerOptions: { cancelGraceMs: 20 },
    });
    await manager.load(fixture.root, fixture.manifest);

    await expect(
      registry.execute('inspect', {}, context({ limits: { timeoutMs: 20, maxOutputChars: 500 } })),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { category: 'tool_timeout', code: 'EXTENSION_CALL_TIMEOUT' },
    });
    await vi.waitFor(() => expect(registry.has('inspect')).toBe(false));
    expect(onQuarantine).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKER_TIMEOUT' }));
  });

  it('fails closed and publishes no tools when initialization is invalid', async () => {
    const fixture = await extension(`throw new Error('cannot initialize');`);
    const registry = new ToolRegistry([]);
    const onQuarantine = vi.fn();
    const manager = new ExtensionRuntimeManager({
      registry,
      workspaceRoot: fixture.root,
      onQuarantine,
    });

    await expect(manager.load(fixture.root, fixture.manifest)).rejects.toMatchObject({
      code: 'WORKER_INITIALIZATION_FAILED',
    });
    expect(registry.has('inspect')).toBe(false);
    expect(onQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WORKER_INITIALIZATION_FAILED' }),
    );
  });

  it('unregisters and quarantines a worker that violates ToolExecution protocol', async () => {
    const fixture = await extension(`
      export const handlers = { inspect: async () => ({ status: 'completed', summary: 'bad' }) };
    `);
    const registry = new ToolRegistry([]);
    const onQuarantine = vi.fn();
    const manager = new ExtensionRuntimeManager({
      registry,
      workspaceRoot: fixture.root,
      onQuarantine,
    });
    await manager.load(fixture.root, fixture.manifest);

    await expect(registry.execute('inspect', {}, context())).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'WORKER_PROTOCOL_ERROR' },
    });
    await vi.waitFor(() => expect(registry.has('inspect')).toBe(false));
    expect(onQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WORKER_PROTOCOL_ERROR' }),
    );
  });

  it('refuses unload while an extension call remains active', async () => {
    const fixture = await extension(`
      export const handlers = {
        inspect: async (_input, context) => new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        })
      };
    `);
    const registry = new ToolRegistry([]);
    const manager = new ExtensionRuntimeManager({ registry, workspaceRoot: fixture.root });
    await manager.load(fixture.root, fixture.manifest);
    const controller = new AbortController();
    const running = registry.execute('inspect', {}, context({ signal: controller.signal }));

    await expect(manager.unload(fixture.manifest.id)).rejects.toMatchObject({
      code: 'EXTENSION_BUSY',
    });
    controller.abort();
    await expect(running).resolves.toMatchObject({ status: 'failed' });
    await vi.waitFor(() => expect(manager.activeCallCount(fixture.manifest.id)).toBe(0));
    await expect(manager.unload(fixture.manifest.id)).resolves.toBe(true);
  });
});
