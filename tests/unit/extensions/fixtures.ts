import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ExtensionCatalogEntry, ExtensionManifest } from '../../../src/contracts/index.js';
import type {
  ExtensionWorkspacePaths,
  WorkspaceExtensionStore,
} from '../../../src/extensions/index.js';

export const tempDirectories: string[] = [];

export async function makeWorkspace(prefix = 'echo-extension-'): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(workspace);
  return workspace;
}

export async function cleanupWorkspaces(): Promise<void> {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
}

export function sampleManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    schemaVersion: 1,
    id: 'pdf-reader',
    version: '1.0.0',
    entry: 'index.mjs',
    selfTest: 'extension.test.mjs',
    tools: [
      {
        name: 'read_pdf',
        description: 'Read text from a synthetic PDF file.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { path: { type: 'string', minLength: 1 } },
          required: ['path'],
        },
      },
    ],
    ...overrides,
  };
}

export async function createStagedExtension(
  store: WorkspaceExtensionStore,
  manifest: ExtensionManifest = sampleManifest(),
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<{ readonly paths: ExtensionWorkspacePaths; readonly root: string }> {
  const paths = await store.ensureWorkspace();
  const root = store.stagingExtensionPath(paths, manifest.id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'extension.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'index.mjs'), 'export const handlers = {};\n');
  await fs.writeFile(path.join(root, 'extension.test.mjs'), 'export const ok = true;\n');
  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return { paths, root };
}

export async function installStagedExtension(
  store: WorkspaceExtensionStore,
  manifest: ExtensionManifest = sampleManifest(),
  state: ExtensionCatalogEntry['state'] = 'enabled',
): Promise<ExtensionCatalogEntry> {
  const { paths, root } = await createStagedExtension(store, manifest);
  const contentHash = await store.hashExtensionDirectory(root, paths.stagingRoot);
  const installedRoot = store.installedExtensionPath(paths, manifest.id, contentHash);
  await fs.mkdir(path.dirname(installedRoot), { recursive: true });
  await fs.cp(root, installedRoot, { recursive: true, errorOnExist: true });
  return {
    id: manifest.id,
    version: manifest.version,
    contentHash,
    state,
    tools: manifest.tools.map((tool) => tool.name),
    installedAt: '2026-08-31T00:00:00.000Z',
    ...(state === 'quarantined' ? { quarantineReason: 'worker initialization failed' } : {}),
  };
}
