import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionManifest, ToolContext } from '../../../src/contracts/index.js';
import {
  createExtensionLifecycleTools,
  ExtensionLifecycleManager,
  type AtomicCatalogWriter,
  type ExtensionLifecycleManagerOptions,
} from '../../../src/extensions/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';

import { cleanupWorkspaces, makeWorkspace } from './fixtures.js';

afterEach(cleanupWorkspaces);

function context(workspaceRoot: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session',
    turnId: 'turn',
    stepId: 'step',
    toolCallId: 'call',
    workspaceRoot,
    signal: new AbortController().signal,
    limits: { timeoutMs: 500, maxOutputChars: 2_000 },
    ...overrides,
  };
}

async function manager(
  options: Pick<ExtensionLifecycleManagerOptions, 'removeTree' | 'storeOptions'> = {},
): Promise<{
  readonly workspace: string;
  readonly registry: ToolRegistry;
  readonly lifecycle: ExtensionLifecycleManager;
}> {
  const workspace = await makeWorkspace();
  const registry = new ToolRegistry([]);
  const lifecycle = await ExtensionLifecycleManager.open({
    workspaceRoot: workspace,
    registry,
    ...options,
  });
  return { workspace, registry, lifecycle };
}

async function writeStaging(
  lifecycle: ExtensionLifecycleManager,
  manifest: ExtensionManifest,
  source: string,
  selfTest = "console.log('self-test ok');\n",
): Promise<void> {
  const root = await lifecycle.store.stagingExtensionPath(manifest.id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'extension.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(root, manifest.entry), source);
  await fs.writeFile(path.join(root, manifest.selfTest), selfTest);
}

function manifest(id = 'pdf-reader', toolName = 'read_pdf', version = '1.0.0'): ExtensionManifest {
  return {
    schemaVersion: 1,
    id,
    version,
    entry: 'index.mjs',
    selfTest: 'extension.test.mjs',
    tools: [
      {
        name: toolName,
        description: `Execute ${toolName}.`,
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ],
  };
}

function completedSource(toolName = 'read_pdf', summary = 'ok'): string {
  return `export const handlers = {\n  ${JSON.stringify(toolName)}: async () => ({ status: 'completed', summary: ${JSON.stringify(summary)}, data: null, truncated: false })\n};\n`;
}

describe('ExtensionLifecycleManager authoring and checks', () => {
  it('creates a complete non-overwriting template and reports a bounded successful check', async () => {
    const fixture = await manager();
    await expect(fixture.lifecycle.init('pdf-reader', ['read_pdf'])).resolves.toMatchObject({
      changed: true,
      state: 'absent',
    });
    const root = await fixture.lifecycle.store.stagingExtensionPath('pdf-reader');
    await expect(fs.readdir(root)).resolves.toEqual(
      expect.arrayContaining(['AUTHORING.md', 'extension.json', 'extension.test.mjs', 'index.mjs']),
    );
    expect(await fs.readFile(path.join(root, 'AUTHORING.md'), 'utf8')).toContain(
      'Worker isolates crashes and cancellation but is not an OS sandbox',
    );
    const report = await fixture.lifecycle.check('pdf-reader', new AbortController().signal);
    expect(report).toMatchObject({ status: 'passed', passedChecks: 4, failedChecks: 0 });
    expect(report.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);

    await expect(fixture.lifecycle.init('pdf-reader', ['other_tool'])).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    expect(JSON.parse(await fs.readFile(path.join(root, 'extension.json'), 'utf8'))).toMatchObject({
      tools: [{ name: 'read_pdf' }],
    });
    await fixture.lifecycle.close();
  });

  it('reports handler and self-test failures without mutating Catalog or loading tools', async () => {
    const fixture = await manager();
    await writeStaging(
      fixture.lifecycle,
      manifest(),
      'export const handlers = {};\n',
      "throw new Error('test failed');\n",
    );
    const report = await fixture.lifecycle.check('pdf-reader', new AbortController().signal);
    expect(report.status).toBe('failed');
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'worker', passed: false }),
        expect.objectContaining({ name: 'self-test', passed: false }),
      ]),
    );
    expect((await fixture.lifecycle.store.readCatalog()).extensions).toEqual([]);
    expect(fixture.registry.has('read_pdf')).toBe(false);
    await fixture.lifecycle.close();
  });

  it('runs staging self-tests without inheriting the provider API key', async () => {
    const fixture = await manager();
    const previous = process.env['ECHO_API_KEY'];
    process.env['ECHO_API_KEY'] = 'must-not-reach-extension-self-test';
    try {
      await writeStaging(
        fixture.lifecycle,
        manifest(),
        completedSource(),
        "if (process.env.ECHO_API_KEY) throw new Error('credential leaked');\n",
      );
      await expect(
        fixture.lifecycle.check('pdf-reader', new AbortController().signal),
      ).resolves.toMatchObject({ status: 'passed' });
    } finally {
      if (previous === undefined) delete process.env['ECHO_API_KEY'];
      else process.env['ECHO_API_KEY'] = previous;
      await fixture.lifecycle.close();
    }
  });
});

describe('ExtensionLifecycleManager state machine', () => {
  it('installs atomically, is idempotent for the same hash, and replaces a changed hash', async () => {
    const fixture = await manager();
    const definition = manifest();
    await writeStaging(fixture.lifecycle, definition, completedSource());
    const first = await fixture.lifecycle.install('pdf-reader', new AbortController().signal);
    expect(first).toMatchObject({ state: 'enabled', changed: true, loaded: true });
    expect(fixture.registry.has('read_pdf')).toBe(true);

    const same = await fixture.lifecycle.install('pdf-reader', new AbortController().signal);
    expect(same).toMatchObject({ changed: false, contentHash: first.contentHash });

    const root = await fixture.lifecycle.store.stagingExtensionPath('pdf-reader');
    await fs.writeFile(path.join(root, 'index.mjs'), completedSource('read_pdf', 'updated'));
    const replaced = await fixture.lifecycle.install('pdf-reader', new AbortController().signal);
    expect(replaced.changed).toBe(true);
    expect(replaced.contentHash).not.toBe(first.contentHash);
    const execution = await fixture.registry.execute('read_pdf', {}, context(fixture.workspace));
    expect(execution).toMatchObject({ status: 'completed', summary: 'updated' });
    expect((await fixture.lifecycle.store.readCatalog()).extensions).toHaveLength(1);
    await fixture.lifecycle.close();
  });

  it('rolls back a changed install when the atomic Catalog replacement fails', async () => {
    let renameCalls = 0;
    const writer: AtomicCatalogWriter = {
      writeAndFlush: async (filePath, contents) => {
        const handle = await fs.open(filePath, 'wx');
        try {
          await handle.writeFile(contents, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      rename: async (from, to) => {
        renameCalls += 1;
        if (renameCalls === 2)
          throw Object.assign(new Error('injected failure'), { code: 'EPERM' });
        await fs.rename(from, to);
      },
      remove: async (target) => fs.rm(target, { force: true }),
    };
    const fixture = await manager({ storeOptions: { catalogWriter: writer } });
    await writeStaging(fixture.lifecycle, manifest(), completedSource('read_pdf', 'original'));
    const original = await fixture.lifecycle.install('pdf-reader', new AbortController().signal);
    const root = await fixture.lifecycle.store.stagingExtensionPath('pdf-reader');
    await fs.writeFile(path.join(root, 'index.mjs'), completedSource('read_pdf', 'replacement'));

    await expect(
      fixture.lifecycle.install('pdf-reader', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CATALOG_WRITE_FAILED' });
    expect((await fixture.lifecycle.store.readCatalog()).extensions[0]?.contentHash).toBe(
      original.contentHash,
    );
    await expect(
      fixture.registry.execute('read_pdf', {}, context(fixture.workspace)),
    ).resolves.toMatchObject({ status: 'completed', summary: 'original' });
    const paths = await fixture.lifecycle.store.ensureWorkspace();
    expect((await fs.readdir(path.join(paths.extensionsRoot, 'pdf-reader'))).length).toBe(1);
    await fixture.lifecycle.close();
  });

  it('persists disable and enable transitions and lists only the bound workspace', async () => {
    const first = await manager();
    const second = await manager();
    await writeStaging(first.lifecycle, manifest(), completedSource());
    await first.lifecycle.install('pdf-reader', new AbortController().signal);
    await expect(first.lifecycle.disable('pdf-reader')).resolves.toMatchObject({
      state: 'disabled',
      loaded: false,
      changed: true,
    });
    await expect(first.lifecycle.disable('pdf-reader')).resolves.toMatchObject({ changed: false });
    expect(first.registry.has('read_pdf')).toBe(false);
    expect(await second.lifecycle.list()).toEqual([]);
    await expect(first.lifecycle.enable('pdf-reader')).resolves.toMatchObject({
      state: 'enabled',
      loaded: true,
    });
    expect(await first.lifecycle.list()).toEqual([
      expect.objectContaining({ id: 'pdf-reader', state: 'enabled', loaded: true }),
    ]);
    await first.lifecycle.close();
    await second.lifecycle.close();
  });

  it('rejects disable and uninstall while a dynamic tool call is active', async () => {
    const fixture = await manager();
    await writeStaging(
      fixture.lifecycle,
      manifest('waiter', 'wait_for_abort'),
      `export const handlers = {\n  wait_for_abort: async (_input, context) => new Promise((resolve) => {\n    context.signal.addEventListener('abort', () => resolve({ status: 'failed', summary: 'cancelled', error: { category: 'cancelled', code: 'CANCELLED', message: 'cancelled', retryable: false }, truncated: false }), { once: true });\n  })\n};\n`,
    );
    await fixture.lifecycle.install('waiter', new AbortController().signal);
    const controller = new AbortController();
    const running = fixture.registry.execute(
      'wait_for_abort',
      {},
      context(fixture.workspace, { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(fixture.lifecycle.runtime.activeCallCount('waiter')).toBe(1));
    await expect(fixture.lifecycle.disable('waiter')).rejects.toMatchObject({
      code: 'EXTENSION_BUSY',
    });
    await expect(fixture.lifecycle.uninstall('waiter')).rejects.toMatchObject({
      code: 'EXTENSION_BUSY',
    });
    controller.abort();
    await expect(running).resolves.toMatchObject({ status: 'failed' });
    await vi.waitFor(() => expect(fixture.lifecycle.runtime.activeCallCount('waiter')).toBe(0));
    await fixture.lifecycle.close();
  });

  it('persists worker faults as quarantined and unregisters all dynamic tools', async () => {
    const fixture = await manager();
    await writeStaging(
      fixture.lifecycle,
      manifest('crasher', 'crash_now'),
      'export const handlers = { crash_now: async () => { process.exit(9); } };\n',
    );
    await fixture.lifecycle.install('crasher', new AbortController().signal);
    await expect(
      fixture.registry.execute('crash_now', {}, context(fixture.workspace)),
    ).resolves.toMatchObject({ status: 'failed' });
    await vi.waitFor(async () => {
      expect((await fixture.lifecycle.store.readCatalog()).extensions[0]).toMatchObject({
        state: 'quarantined',
      });
    });
    expect(fixture.registry.has('crash_now')).toBe(false);
    await fixture.lifecycle.close();
  });

  it('reports deactivated cleanupPending on deletion failure and permits idempotent retry', async () => {
    const removeTree = vi.fn(async () => {
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    });
    const fixture = await manager({ removeTree });
    await writeStaging(fixture.lifecycle, manifest(), completedSource());
    await fixture.lifecycle.install('pdf-reader', new AbortController().signal);
    await expect(fixture.lifecycle.uninstall('pdf-reader')).resolves.toMatchObject({
      state: 'absent',
      deactivated: true,
      cleanupPending: true,
      loaded: false,
    });
    expect(fixture.registry.has('read_pdf')).toBe(false);
    expect((await fixture.lifecycle.store.readCatalog()).extensions).toEqual([]);
    await fixture.lifecycle.close();

    const retryRegistry = new ToolRegistry([]);
    const retry = await ExtensionLifecycleManager.open({
      workspaceRoot: fixture.workspace,
      registry: retryRegistry,
    });
    await expect(retry.uninstall('pdf-reader')).resolves.toMatchObject({
      state: 'absent',
      cleanupPending: false,
    });
    await retry.close();
  });
});

describe('Extension lifecycle tool definitions', () => {
  it('exposes exactly seven bounded tools and maps expected failures to stable ToolExecution errors', async () => {
    const fixture = await manager();
    const tools = createExtensionLifecycleTools(fixture.lifecycle);
    expect(tools.map((tool) => tool.name)).toEqual([
      'extension_init',
      'extension_check',
      'extension_install',
      'extension_list',
      'extension_enable',
      'extension_disable',
      'extension_uninstall',
    ]);
    const enable = tools.find((tool) => tool.name === 'extension_enable');
    const init = tools.find((tool) => tool.name === 'extension_init');
    if (enable === undefined || init === undefined) throw new Error('Lifecycle tools are missing.');
    await expect(
      enable.execute({ extensionId: 'missing' }, context(fixture.workspace)),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'EXTENSION_NOT_FOUND' },
    });
    await expect(
      init.execute({ extensionId: 'Bad Id', toolNames: [] }, context(fixture.workspace)),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { category: 'storage', code: 'MANIFEST_INVALID' },
    });
    await fixture.lifecycle.close();
  });
});
