import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceExtensionStore } from '../../../src/extensions/index.js';

import { cleanupWorkspaces, installStagedExtension, makeWorkspace } from './fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

afterEach(cleanupWorkspaces);

describe('extension workspace isolation', () => {
  it('never observes another workspace catalog', async () => {
    const first = new WorkspaceExtensionStore(await makeWorkspace('echo-extension-first-'));
    const second = new WorkspaceExtensionStore(await makeWorkspace('echo-extension-second-'));
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
