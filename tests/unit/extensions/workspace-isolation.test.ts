import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import { WorkspaceExtensionStore } from '../../../src/extensions/index.js';
import * as extensionApi from '../../../src/extensions/index.js';

import {
  cleanupWorkspaces,
  createStagedExtension,
  installStagedExtension,
  makeWorkspace,
  sampleManifest,
} from './fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

afterEach(cleanupWorkspaces);

describe('extension workspace isolation', () => {
  it('keeps all path derivation inputs bound to the store workspace', () => {
    expectTypeOf<Parameters<WorkspaceExtensionStore['stagingExtensionPath']>>().toEqualTypeOf<
      [extensionId: string]
    >();
    expectTypeOf<Parameters<WorkspaceExtensionStore['installedExtensionPath']>>().toEqualTypeOf<
      [extensionId: string, contentHash: string]
    >();
    expectTypeOf<WorkspaceExtensionStore>().not.toHaveProperty('hashExtensionDirectory');
    expect(extensionApi).not.toHaveProperty('snapshotExtensionContent');
    expect(extensionApi).not.toHaveProperty('ensureExtensionWorkspacePaths');
    expect(extensionApi).not.toHaveProperty('stagingExtensionPath');
    expect(extensionApi).not.toHaveProperty('installedExtensionPath');
  });

  it('derives paths and snapshots from its own workspace even when another uses the same id', async () => {
    const first = await WorkspaceExtensionStore.open(await makeWorkspace('echo-extension-first-'));
    const second = await WorkspaceExtensionStore.open(
      await makeWorkspace('echo-extension-second-'),
    );
    await createStagedExtension(first, sampleManifest(), {
      'workspace.mjs': 'export const id = 1;\n',
    });
    await createStagedExtension(second, sampleManifest(), {
      'workspace.mjs': 'export const id = 2;\n',
    });

    const firstPaths = await first.ensureWorkspace();
    const secondPaths = await second.ensureWorkspace();
    expect(await first.stagingExtensionPath('pdf-reader')).toBe(
      path.join(firstPaths.stagingRoot, 'pdf-reader'),
    );
    expect(await second.stagingExtensionPath('pdf-reader')).toBe(
      path.join(secondPaths.stagingRoot, 'pdf-reader'),
    );
    expect((await first.snapshotStagedExtension('pdf-reader')).contentHash).not.toBe(
      (await second.snapshotStagedExtension('pdf-reader')).contentHash,
    );
  });

  it('keeps the canonical workspace fixed when the original junction is retargeted', async () => {
    const firstRoot = await makeWorkspace('echo-extension-first-');
    const secondRoot = await makeWorkspace('echo-extension-second-');
    const aliasParent = await makeWorkspace('echo-extension-alias-');
    const alias = path.join(aliasParent, 'workspace');
    await fs.symlink(firstRoot, alias, 'junction');
    const store = await WorkspaceExtensionStore.open(alias);

    await fs.rm(alias, { force: true });
    await fs.symlink(secondRoot, alias, 'junction');

    expect((await store.ensureWorkspace()).workspaceRoot).toBe(await fs.realpath(firstRoot));
    expect(await store.stagingExtensionPath('pdf-reader')).toBe(
      path.join(await fs.realpath(firstRoot), '.echo', 'extension-staging', 'pdf-reader'),
    );
    await expect(fs.stat(path.join(secondRoot, '.echo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a bound extension directory is replaced at the same path', async () => {
    const store = await WorkspaceExtensionStore.open(await makeWorkspace());
    const paths = await store.ensureWorkspace();
    const moved = path.join(paths.echoRoot, 'extension-staging-replaced');
    await fs.rename(paths.stagingRoot, moved);
    await fs.mkdir(paths.stagingRoot);

    await expect(store.ensureWorkspace()).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
    await expect(store.stagingExtensionPath('pdf-reader')).rejects.toMatchObject({
      code: 'WORKSPACE_CHANGED',
    });
  });

  it('does not expose mutable paths that can redirect the bound store', async () => {
    const store = await WorkspaceExtensionStore.open(await makeWorkspace('echo-extension-first-'));
    const foreign = await WorkspaceExtensionStore.open(
      await makeWorkspace('echo-extension-second-'),
    );
    const original = await store.ensureWorkspace();
    const returned = (await store.ensureWorkspace()) as { stagingRoot: string };
    returned.stagingRoot = (await foreign.ensureWorkspace()).stagingRoot;

    expect(await store.stagingExtensionPath('pdf-reader')).toBe(
      path.join(original.stagingRoot, 'pdf-reader'),
    );
  });

  it('never observes another workspace catalog', async () => {
    const first = await WorkspaceExtensionStore.open(await makeWorkspace('echo-extension-first-'));
    const second = await WorkspaceExtensionStore.open(
      await makeWorkspace('echo-extension-second-'),
    );
    const entry = await installStagedExtension(first);
    await first.replaceCatalog(0, [entry]);

    await expect(first.readCatalog()).resolves.toMatchObject({
      extensions: [{ id: 'pdf-reader' }],
    });
    await expect(second.readCatalog()).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      extensions: [],
    });
  });

  it('keeps every workspace extension artifact ignored by Git', async () => {
    const gitignore = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore.split(/\r?\n/u)).toContain('.echo/');
  });
});
