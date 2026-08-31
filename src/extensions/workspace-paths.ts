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

interface BoundDirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly birthtimeMs: number;
}

export interface BoundExtensionWorkspace {
  readonly paths: ExtensionWorkspacePaths;
  readonly directories: readonly BoundDirectoryIdentity[];
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

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function captureDirectoryIdentity(directory: string): Promise<BoundDirectoryIdentity> {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink()) {
    throw new ExtensionStorageError(
      'LINK_DENIED',
      'A bound extension workspace directory cannot be a symbolic link or junction.',
    );
  }
  if (!stats.isDirectory()) {
    throw new ExtensionStorageError(
      'WORKSPACE_INVALID',
      'A bound extension workspace path is not a directory.',
    );
  }
  const canonical = await fs.realpath(directory);
  if (!pathsEqual(directory, canonical)) {
    throw new ExtensionStorageError(
      'LINK_DENIED',
      'A bound extension workspace directory resolves through a link or junction.',
    );
  }
  return Object.freeze({
    path: canonical,
    device: stats.dev,
    inode: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  });
}

export async function bindExtensionWorkspace(
  workspaceRoot: string,
): Promise<BoundExtensionWorkspace> {
  const created = await ensureExtensionWorkspacePaths(workspaceRoot);
  const paths = Object.freeze({ ...created });
  const directories = await Promise.all(
    [
      paths.workspaceRoot,
      paths.echoRoot,
      paths.stagingRoot,
      paths.extensionsRoot,
      paths.trashRoot,
    ].map(captureDirectoryIdentity),
  );
  return Object.freeze({ paths, directories: Object.freeze(directories) });
}

export async function assertExtensionWorkspaceBinding(
  binding: BoundExtensionWorkspace,
): Promise<void> {
  for (const expected of binding.directories) {
    let actual: BoundDirectoryIdentity;
    try {
      actual = await captureDirectoryIdentity(expected.path);
    } catch (error) {
      if (error instanceof ExtensionStorageError && error.code === 'LINK_DENIED') throw error;
      throw new ExtensionStorageError(
        'WORKSPACE_CHANGED',
        'A bound extension workspace directory is missing or no longer valid.',
        error,
      );
    }
    if (
      !pathsEqual(actual.path, expected.path) ||
      actual.device !== expected.device ||
      actual.inode !== expected.inode ||
      actual.birthtimeMs !== expected.birthtimeMs
    ) {
      throw new ExtensionStorageError(
        'WORKSPACE_CHANGED',
        'A bound extension workspace directory was replaced after the store opened.',
      );
    }
  }
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
