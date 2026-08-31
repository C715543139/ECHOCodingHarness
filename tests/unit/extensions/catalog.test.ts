import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WorkspaceExtensionStore,
  type AtomicCatalogWriter,
} from '../../../src/extensions/index.js';

import {
  cleanupWorkspaces,
  installStagedExtension,
  makeWorkspace,
  sampleManifest,
} from './fixtures.js';

afterEach(cleanupWorkspaces);

describe('Catalog v1', () => {
  it('round-trips enabled, disabled, and quarantined entries with monotonic revisions', async () => {
    const store = new WorkspaceExtensionStore(await makeWorkspace());
    const enabled = await installStagedExtension(store);
    const baseTool = sampleManifest().tools.at(0);
    if (baseTool === undefined) throw new Error('Fixture tool is missing.');
    const disabled = await installStagedExtension(
      store,
      sampleManifest({
        id: 'table-reader',
        tools: [{ ...baseTool, name: 'read_table' }],
      }),
      'disabled',
    );
    const quarantined = await installStagedExtension(
      store,
      sampleManifest({
        id: 'image-reader',
        tools: [{ ...baseTool, name: 'read_image' }],
      }),
      'quarantined',
    );

    const written = await store.replaceCatalog(0, [quarantined, enabled, disabled]);
    expect(written.revision).toBe(1);
    expect(written.extensions.map((entry) => entry.id)).toEqual([
      'image-reader',
      'pdf-reader',
      'table-reader',
    ]);
    await expect(store.readCatalog()).resolves.toEqual(written);

    const next = await store.replaceCatalog(1, [
      { ...enabled, state: 'disabled' },
      disabled,
      quarantined,
    ]);
    expect(next.revision).toBe(2);
  });

  it('rejects corrupt, unknown-version, unknown-field, and invalid-state catalogs without rebuilding', async () => {
    const workspace = await makeWorkspace();
    const store = new WorkspaceExtensionStore(workspace);
    const paths = await store.ensureWorkspace();
    const cases: readonly (readonly [string, unknown, string])[] = [
      ['corrupt', '{bad', 'CATALOG_CORRUPT'],
      ['version', { schemaVersion: 2, revision: 0, extensions: [] }, 'CATALOG_VERSION_UNSUPPORTED'],
      [
        'unknown field',
        { schemaVersion: 1, revision: 0, extensions: [], extra: true },
        'CATALOG_CORRUPT',
      ],
      [
        'bad state',
        {
          schemaVersion: 1,
          revision: 1,
          extensions: [
            {
              id: 'pdf-reader',
              version: '1.0.0',
              contentHash: `sha256:${'a'.repeat(64)}`,
              state: 'broken',
              tools: ['read_pdf'],
              installedAt: '2026-08-31T00:00:00.000Z',
            },
          ],
        },
        'CATALOG_CORRUPT',
      ],
    ];

    for (const [, value, code] of cases) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      await fs.writeFile(paths.catalogPath, text);
      await expect(store.readCatalog()).rejects.toMatchObject({ code });
      expect(await fs.readFile(paths.catalogPath, 'utf8')).toBe(text);
    }
  });

  it('fails closed when the installed directory hash changes', async () => {
    const store = new WorkspaceExtensionStore(await makeWorkspace());
    const entry = await installStagedExtension(store);
    await store.replaceCatalog(0, [entry]);
    await fs.writeFile(
      path.join(await store.installedExtensionPath(entry.id, entry.contentHash), 'index.mjs'),
      'export const tampered = true;\n',
    );

    await expect(store.readCatalog()).rejects.toMatchObject({
      code: 'CATALOG_INTEGRITY_FAILED',
    });
  });

  it('rejects a catalog symbolic link instead of reading another file', async () => {
    const store = new WorkspaceExtensionStore(await makeWorkspace());
    const paths = await store.ensureWorkspace();
    const external = path.join(paths.workspaceRoot, 'external-catalog.json');
    await fs.writeFile(external, JSON.stringify({ schemaVersion: 1, revision: 0, extensions: [] }));
    await fs.symlink(external, paths.catalogPath, 'file');

    await expect(store.readCatalog()).rejects.toMatchObject({ code: 'LINK_DENIED' });
  });

  it('keeps the previous catalog when its atomic replacement fails', async () => {
    const workspace = await makeWorkspace();
    const initialStore = new WorkspaceExtensionStore(workspace);
    const entry = await installStagedExtension(initialStore);
    await initialStore.replaceCatalog(0, [entry]);
    const paths = await initialStore.ensureWorkspace();
    const previous = await fs.readFile(paths.catalogPath, 'utf8');

    const writer: AtomicCatalogWriter = {
      writeAndFlush: async (filePath, contents) => {
        await fs.writeFile(filePath, contents, { flag: 'wx' });
      },
      rename: async () => {
        throw Object.assign(new Error('injected atomic replace failure'), { code: 'EPERM' });
      },
      remove: async (filePath) => {
        await fs.rm(filePath, { force: true });
      },
    };
    const failingStore = new WorkspaceExtensionStore(workspace, { catalogWriter: writer });

    await expect(
      failingStore.replaceCatalog(1, [{ ...entry, state: 'disabled' }]),
    ).rejects.toMatchObject({ code: 'CATALOG_WRITE_FAILED' });
    expect(await fs.readFile(paths.catalogPath, 'utf8')).toBe(previous);
    expect(
      (await fs.readdir(paths.extensionsRoot)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('rejects stale revisions and an uncertain missing catalog without guessing from directories', async () => {
    const store = new WorkspaceExtensionStore(await makeWorkspace());
    const entry = await installStagedExtension(store);
    await store.replaceCatalog(0, [entry]);
    await expect(store.replaceCatalog(0, [entry])).rejects.toMatchObject({
      code: 'CATALOG_REVISION_CONFLICT',
    });

    const paths = await store.ensureWorkspace();
    await fs.rm(paths.catalogPath);
    await expect(store.readCatalog()).rejects.toMatchObject({
      code: 'CATALOG_RECOVERY_UNCERTAIN',
    });
  });
});
