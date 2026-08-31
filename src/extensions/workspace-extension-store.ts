import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ExtensionCatalog,
  ExtensionCatalogEntry,
  ExtensionManifest,
} from '../contracts/index.js';
import { DEFAULT_TOOLS } from '../tools/index.js';

import {
  parseExtensionCatalog,
  serializeExtensionCatalog,
  validateExtensionCatalog,
} from './catalog-validation.js';
import { snapshotExtensionContent, type ExtensionContentSnapshot } from './content-hash.js';
import { ExtensionStorageError, isFileSystemError } from './errors.js';
import { parseExtensionManifest } from './manifest.js';
import {
  ensureExtensionWorkspacePaths,
  installedExtensionPath,
  stagingExtensionPath,
  type ExtensionWorkspacePaths,
} from './workspace-paths.js';

export interface AtomicCatalogWriter {
  writeAndFlush(filePath: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

export interface WorkspaceExtensionStoreOptions {
  readonly builtInToolNames?: readonly string[];
  readonly catalogWriter?: AtomicCatalogWriter;
}

const defaultCatalogWriter: AtomicCatalogWriter = {
  writeAndFlush: async (filePath, contents) => {
    const handle = await fs.open(filePath, 'wx');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: async (from, to) => fs.rename(from, to),
  remove: async (filePath) => fs.rm(filePath, { force: true }),
};

const EMPTY_CATALOG: ExtensionCatalog = { schemaVersion: 1, revision: 0, extensions: [] };

export class WorkspaceExtensionStore {
  private readonly builtInToolNames: ReadonlySet<string>;
  private readonly catalogWriter: AtomicCatalogWriter;

  constructor(
    private readonly workspaceRoot: string,
    options: WorkspaceExtensionStoreOptions = {},
  ) {
    this.builtInToolNames = new Set(
      options.builtInToolNames ?? DEFAULT_TOOLS.map((tool) => tool.name),
    );
    this.catalogWriter = options.catalogWriter ?? defaultCatalogWriter;
  }

  ensureWorkspace(): Promise<ExtensionWorkspacePaths> {
    return ensureExtensionWorkspacePaths(this.workspaceRoot);
  }

  stagingExtensionPath(paths: ExtensionWorkspacePaths, extensionId: string): string {
    return stagingExtensionPath(paths, extensionId);
  }

  installedExtensionPath(
    paths: ExtensionWorkspacePaths,
    extensionId: string,
    contentHash: string,
  ): string {
    return installedExtensionPath(paths, extensionId, contentHash);
  }

  async hashExtensionDirectory(
    extensionRoot: string,
    ownedRoot: string,
    expectedId?: string,
  ): Promise<string> {
    return (await snapshotExtensionContent(extensionRoot, ownedRoot, expectedId)).contentHash;
  }

  async readStagedManifest(extensionId: string): Promise<ExtensionManifest> {
    const paths = await this.ensureWorkspace();
    const root = this.stagingExtensionPath(paths, extensionId);
    return (await snapshotExtensionContent(root, paths.stagingRoot, extensionId)).manifest;
  }

  async snapshotStagedExtension(extensionId: string): Promise<ExtensionContentSnapshot> {
    const paths = await this.ensureWorkspace();
    return snapshotExtensionContent(
      this.stagingExtensionPath(paths, extensionId),
      paths.stagingRoot,
      extensionId,
    );
  }

  async snapshotInstalledExtension(
    entry: ExtensionCatalogEntry,
  ): Promise<ExtensionContentSnapshot> {
    const paths = await this.ensureWorkspace();
    return snapshotExtensionContent(
      this.installedExtensionPath(paths, entry.id, entry.contentHash),
      paths.extensionsRoot,
      entry.id,
    );
  }

  assertToolNamesAvailable(
    manifest: ExtensionManifest,
    catalog: ExtensionCatalog,
    replacingExtensionId: string | undefined = manifest.id,
  ): void {
    const names = new Set<string>();
    for (const tool of manifest.tools) {
      if (tool.name.startsWith('extension_') || this.builtInToolNames.has(tool.name)) {
        throw new ExtensionStorageError(
          'TOOL_NAME_CONFLICT',
          `Tool name "${tool.name}" is reserved or built in.`,
        );
      }
      if (names.has(tool.name)) {
        throw new ExtensionStorageError(
          'TOOL_NAME_CONFLICT',
          `Tool name "${tool.name}" is duplicated.`,
        );
      }
      names.add(tool.name);
      const owner = catalog.extensions.find(
        (entry) => entry.id !== replacingExtensionId && entry.tools.includes(tool.name),
      );
      if (owner !== undefined) {
        throw new ExtensionStorageError(
          'TOOL_NAME_CONFLICT',
          `Tool name "${tool.name}" is already owned by extension "${owner.id}".`,
        );
      }
    }
  }

  async readCatalog(): Promise<ExtensionCatalog> {
    const paths = await this.ensureWorkspace();
    const catalog = await this.readCatalogFile(paths, false);
    await this.verifyCatalog(paths, catalog);
    return catalog;
  }

  async replaceCatalog(
    expectedRevision: number,
    entries: readonly ExtensionCatalogEntry[],
  ): Promise<ExtensionCatalog> {
    const paths = await this.ensureWorkspace();
    const current = await this.readCatalogFile(paths, true);
    if (current.revision !== expectedRevision) {
      throw new ExtensionStorageError(
        'CATALOG_REVISION_CONFLICT',
        `Catalog revision changed from ${String(expectedRevision)} to ${String(current.revision)}.`,
      );
    }
    if (current.revision > 0 || current.extensions.length > 0)
      await this.verifyCatalog(paths, current);
    const next = validateExtensionCatalog(
      { schemaVersion: 1, revision: current.revision + 1, extensions: entries },
      this.builtInToolNames,
    );
    await this.verifyCatalog(paths, next);
    const serialized = serializeExtensionCatalog(next);
    const tempPath = path.join(
      paths.extensionsRoot,
      `.catalog.json.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    try {
      await this.catalogWriter.writeAndFlush(tempPath, serialized);
      await this.catalogWriter.rename(tempPath, paths.catalogPath);
    } catch (error) {
      try {
        await this.catalogWriter.remove(tempPath);
      } catch {
        // The write failure remains authoritative; cleanup is best effort and never rebuilds state.
      }
      throw new ExtensionStorageError(
        'CATALOG_WRITE_FAILED',
        'Extension catalog atomic write failed.',
        error,
      );
    }
    return next;
  }

  private async readCatalogFile(
    paths: ExtensionWorkspacePaths,
    allowMissingWithInstalledDirectories: boolean,
  ): Promise<ExtensionCatalog> {
    let text: string;
    try {
      const before = await fs.lstat(paths.catalogPath);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new ExtensionStorageError(
          'LINK_DENIED',
          'Extension catalog must be a regular file and cannot be a link.',
        );
      }
      text = await fs.readFile(paths.catalogPath, 'utf8');
      const after = await fs.lstat(paths.catalogPath);
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new ExtensionStorageError(
          'CATALOG_READ_FAILED',
          'Extension catalog changed while it was being read.',
        );
      }
    } catch (error) {
      if (error instanceof ExtensionStorageError) throw error;
      if (isFileSystemError(error, 'ENOENT')) {
        if (!allowMissingWithInstalledDirectories) {
          const children = await fs.readdir(paths.extensionsRoot, { withFileTypes: true });
          const uncertain = children.some((child) => child.name !== '.trash');
          if (uncertain) {
            throw new ExtensionStorageError(
              'CATALOG_RECOVERY_UNCERTAIN',
              'Catalog is missing while extension storage contains untracked state.',
            );
          }
        }
        return EMPTY_CATALOG;
      }
      throw new ExtensionStorageError(
        'CATALOG_READ_FAILED',
        'Extension catalog could not be read.',
        error,
      );
    }
    return parseExtensionCatalog(text, this.builtInToolNames);
  }

  private async verifyCatalog(
    paths: ExtensionWorkspacePaths,
    catalog: ExtensionCatalog,
  ): Promise<void> {
    for (const entry of catalog.extensions) {
      try {
        const root = this.installedExtensionPath(paths, entry.id, entry.contentHash);
        const snapshot = await snapshotExtensionContent(root, paths.extensionsRoot, entry.id);
        if (
          snapshot.contentHash !== entry.contentHash ||
          snapshot.manifest.version !== entry.version ||
          snapshot.manifest.tools.length !== entry.tools.length ||
          snapshot.manifest.tools.some((tool, index) => tool.name !== entry.tools[index])
        ) {
          throw new Error('Catalog entry does not match its installed content.');
        }
        this.assertToolNamesAvailable(snapshot.manifest, catalog, entry.id);
      } catch (error) {
        if (error instanceof ExtensionStorageError && error.code === 'TOOL_NAME_CONFLICT')
          throw error;
        throw new ExtensionStorageError(
          'CATALOG_INTEGRITY_FAILED',
          `Installed content for extension "${entry.id}" does not match the catalog.`,
          error,
        );
      }
    }
  }
}

export { parseExtensionManifest };
