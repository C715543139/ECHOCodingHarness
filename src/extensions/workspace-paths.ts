import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ExtensionStorageError, isFileSystemError } from './errors.js';
import { assertValidExtensionId } from './manifest.js';

export interface ExtensionWorkspacePaths {
  readonly workspaceRoot: string;
  readonly echoRoot: string;
  readonly stagingRoot: string;
  readonly extensionsRoot: string;
  readonly catalogPath: string;
  readonly trashRoot: string;
}

function ensureContained(
  root: string,
  candidate: string,
  code: 'PATH_OUTSIDE_EXTENSION_ROOT' | 'LINK_DENIED',
): void {
  const relative = path.relative(root, candidate);
  if (relative === '' && code === 'PATH_OUTSIDE_EXTENSION_ROOT') {
    throw new ExtensionStorageError(code, 'An extension directory must be below its owned root.');
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ExtensionStorageError(
      code,
      'The resolved extension path leaves its owned workspace root.',
    );
  }
}

async function ensurePlainDirectory(parent: string, name: string): Promise<string> {
  const target = path.join(parent, name);
  try {
    await fs.mkdir(target);
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) throw error;
  }
  const stats = await fs.lstat(target);
  if (stats.isSymbolicLink()) {
    throw new ExtensionStorageError(
      'LINK_DENIED',
      `Extension storage directory "${name}" cannot be a link.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new ExtensionStorageError(
      'WORKSPACE_INVALID',
      `Extension storage path "${name}" is not a directory.`,
    );
  }
  const resolved = await fs.realpath(target);
  ensureContained(parent, resolved, 'LINK_DENIED');
  return resolved;
}

export async function ensureExtensionWorkspacePaths(
  workspaceRoot: string,
): Promise<ExtensionWorkspacePaths> {
  if (workspaceRoot.length === 0) {
    throw new ExtensionStorageError('WORKSPACE_INVALID', 'Workspace root is not configured.');
  }
  const configuredRoot = path.resolve(workspaceRoot);
  let canonicalRoot: string;
  try {
    const stats = await fs.stat(configuredRoot);
    if (!stats.isDirectory()) throw new Error('not a directory');
    canonicalRoot = await fs.realpath(configuredRoot);
  } catch (error) {
    throw new ExtensionStorageError(
      'WORKSPACE_INVALID',
      'Workspace root does not exist or is not a directory.',
      error,
    );
  }
  const echoRoot = await ensurePlainDirectory(canonicalRoot, '.echo');
  const stagingRoot = await ensurePlainDirectory(echoRoot, 'extension-staging');
  const extensionsRoot = await ensurePlainDirectory(echoRoot, 'extensions');
  const trashRoot = await ensurePlainDirectory(extensionsRoot, '.trash');
  return {
    workspaceRoot: canonicalRoot,
    echoRoot,
    stagingRoot,
    extensionsRoot,
    catalogPath: path.join(extensionsRoot, 'catalog.json'),
    trashRoot,
  };
}

export async function assertOwnedExtensionDirectory(
  extensionRoot: string,
  ownedRoot: string,
): Promise<string> {
  const canonicalOwnedRoot = await fs.realpath(ownedRoot);
  const lexicalRoot = path.resolve(extensionRoot);
  ensureContained(canonicalOwnedRoot, lexicalRoot, 'PATH_OUTSIDE_EXTENSION_ROOT');

  const relative = path.relative(canonicalOwnedRoot, lexicalRoot);
  let current = canonicalOwnedRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      throw new ExtensionStorageError(
        'EXTENSION_CONTENT_INVALID',
        'Extension directory is missing or unreadable.',
        error,
      );
    }
    if (stats.isSymbolicLink()) {
      throw new ExtensionStorageError(
        'LINK_DENIED',
        'Extension paths cannot contain symbolic links or junctions.',
      );
    }
  }
  const resolved = await fs.realpath(lexicalRoot);
  ensureContained(canonicalOwnedRoot, resolved, 'PATH_OUTSIDE_EXTENSION_ROOT');
  const rootStats = await fs.stat(resolved);
  if (!rootStats.isDirectory()) {
    throw new ExtensionStorageError(
      'EXTENSION_CONTENT_INVALID',
      'Extension root must be a directory.',
    );
  }
  return resolved;
}

export function stagingExtensionPath(paths: ExtensionWorkspacePaths, extensionId: string): string {
  assertValidExtensionId(extensionId, 'extensionId');
  return path.join(paths.stagingRoot, extensionId);
}

export function installedExtensionPath(
  paths: ExtensionWorkspacePaths,
  extensionId: string,
  contentHash: string,
): string {
  assertValidExtensionId(extensionId, 'extensionId');
  const match = /^sha256:([a-f0-9]{64})$/u.exec(contentHash);
  if (match === null) {
    throw new ExtensionStorageError(
      'CATALOG_CORRUPT',
      'Extension contentHash must use sha256:<hex>.',
    );
  }
  const hex = match[1];
  if (hex === undefined) {
    throw new ExtensionStorageError('CATALOG_CORRUPT', 'Extension contentHash is incomplete.');
  }
  return path.join(paths.extensionsRoot, extensionId, hex);
}
