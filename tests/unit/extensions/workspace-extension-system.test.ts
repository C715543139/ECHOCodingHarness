import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExtensionManifest } from '../../../src/contracts/index.js';
import { WorkspaceExtensionSystem } from '../../../src/extensions/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';

import { cleanupWorkspaces, makeWorkspace } from './fixtures.js';

afterEach(cleanupWorkspaces);

const manifest: ExtensionManifest = {
  schemaVersion: 1,
  id: 'pdf-reader',
  version: '1.0.0',
  entry: 'index.mjs',
  selfTest: 'extension.test.mjs',
  tools: [
    {
      name: 'read_pdf',
      description: 'Read a synthetic PDF.',
      inputSchema: { type: 'object', additionalProperties: false },
    },
  ],
};

async function stage(system: WorkspaceExtensionSystem): Promise<void> {
  const root = await system.lifecycle.store.stagingExtensionPath(manifest.id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'extension.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(
    path.join(root, manifest.entry),
    `export const handlers = { read_pdf: async () => ({ status: 'completed', summary: 'read', data: { text: 'fixture' }, truncated: false }) };\n`,
  );
  await fs.writeFile(path.join(root, manifest.selfTest), `console.log('ok');\n`);
}

describe('WorkspaceExtensionSystem', () => {
  it('exposes lifecycle and enabled extension tools only at Full Access request boundaries', async () => {
    const workspaceRoot = await makeWorkspace();
    const registry = new ToolRegistry([]);
    const system = await WorkspaceExtensionSystem.open({ workspaceRoot, registry });
    await stage(system);

    await system.prepareForTurn('full-access');
    expect(registry.has('extension_install')).toBe(true);
    await system.lifecycle.install('pdf-reader', new AbortController().signal);
    expect(registry.has('read_pdf')).toBe(true);

    await system.prepareForTurn('balanced');
    expect(registry.has('extension_install')).toBe(false);
    expect(registry.has('read_pdf')).toBe(false);
    expect(await system.lifecycle.list()).toMatchObject([
      { id: 'pdf-reader', state: 'enabled', loaded: false },
    ]);

    await system.lifecycle.disable('pdf-reader');
    await system.lifecycle.enable('pdf-reader');
    expect(registry.has('read_pdf')).toBe(false);
    await system.prepareForTurn('full-access');
    expect(registry.has('read_pdf')).toBe(true);
    await system.close();
  });

  it('restores enabled extensions across process restart but never across workspaces', async () => {
    const workspaceRoot = await makeWorkspace();
    const firstRegistry = new ToolRegistry([]);
    const first = await WorkspaceExtensionSystem.open({
      workspaceRoot,
      registry: firstRegistry,
    });
    await stage(first);
    await first.prepareForTurn('full-access');
    await first.lifecycle.install('pdf-reader', new AbortController().signal);
    await first.close();

    const restartedRegistry = new ToolRegistry([]);
    const restarted = await WorkspaceExtensionSystem.open({
      workspaceRoot,
      registry: restartedRegistry,
    });
    expect(restartedRegistry.has('read_pdf')).toBe(false);
    await restarted.prepareForTurn('full-access');
    expect(restartedRegistry.has('read_pdf')).toBe(true);

    const otherRegistry = new ToolRegistry([]);
    const other = await WorkspaceExtensionSystem.open({
      workspaceRoot: await makeWorkspace(),
      registry: otherRegistry,
    });
    await other.prepareForTurn('full-access');
    expect(otherRegistry.has('read_pdf')).toBe(false);
    expect(await other.lifecycle.list()).toEqual([]);

    await restarted.close();
    await other.close();
  });
});
