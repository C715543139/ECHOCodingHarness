import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceExtensionStore } from '../../../src/extensions/index.js';

import {
  cleanupWorkspaces,
  createStagedExtension,
  makeWorkspace,
  sampleManifest,
} from './fixtures.js';

afterEach(cleanupWorkspaces);

describe('workspace extension paths and content hashes', () => {
  it('creates only the current workspace staging, install, and trash roots', async () => {
    const first = await makeWorkspace('echo-extension-first-');
    const second = await makeWorkspace('echo-extension-second-');
    const store = new WorkspaceExtensionStore(first);
    const paths = await store.ensureWorkspace();

    expect(path.relative(paths.workspaceRoot, paths.stagingRoot)).toBe(
      path.join('.echo', 'extension-staging'),
    );
    expect(path.relative(paths.workspaceRoot, paths.extensionsRoot)).toBe(
      path.join('.echo', 'extensions'),
    );
    expect(path.relative(paths.workspaceRoot, paths.trashRoot)).toBe(
      path.join('.echo', 'extensions', '.trash'),
    );
    await expect(fs.stat(path.join(second, '.echo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hashes a normalized sorted file collection and detects any content change', async () => {
    const store = new WorkspaceExtensionStore(await makeWorkspace());
    const { paths, root } = await createStagedExtension(store, sampleManifest(), {
      'lib/helper.mjs': 'export const value = 1;\n',
    });

    const first = await store.hashExtensionDirectory(root, paths.stagingRoot);
    const second = await store.hashExtensionDirectory(root, paths.stagingRoot);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(second).toBe(first);

    await fs.writeFile(path.join(root, 'lib', 'helper.mjs'), 'export const value = 2;\n');
    expect(await store.hashExtensionDirectory(root, paths.stagingRoot)).not.toBe(first);
  });

  it('rejects an extension path that escapes its owned root', async () => {
    const store = new WorkspaceExtensionStore(await makeWorkspace());
    const paths = await store.ensureWorkspace();
    await expect(
      store.hashExtensionDirectory(paths.workspaceRoot, paths.stagingRoot),
    ).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_EXTENSION_ROOT',
    });
  });

  it('rejects junctions or symbolic links even when their target remains in the workspace', async () => {
    const store = new WorkspaceExtensionStore(await makeWorkspace());
    const { paths, root } = await createStagedExtension(store);
    const linkedTarget = path.join(paths.workspaceRoot, 'linked-source');
    await fs.mkdir(linkedTarget);
    await fs.writeFile(path.join(linkedTarget, 'helper.mjs'), 'export {};\n');
    await fs.symlink(linkedTarget, path.join(root, 'linked'), 'junction');

    await expect(store.hashExtensionDirectory(root, paths.stagingRoot)).rejects.toMatchObject({
      code: 'LINK_DENIED',
    });
  });

  it('rejects a linked .echo root instead of following it', async () => {
    const workspace = await makeWorkspace();
    const external = await makeWorkspace('echo-extension-external-');
    await fs.symlink(external, path.join(workspace, '.echo'), 'junction');

    await expect(new WorkspaceExtensionStore(workspace).ensureWorkspace()).rejects.toMatchObject({
      code: 'LINK_DENIED',
    });
  });
});
