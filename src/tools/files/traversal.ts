import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { assertNotAborted, FileToolError } from './errors.js';
import { matchesGlob } from './glob.js';
import {
  assertRealPathInsideWorkspace,
  toWorkspacePath,
  type ResolvedWorkspacePath,
} from './path-safety.js';

const MAX_TRAVERSED_ENTRIES = 50_000;

export interface TraversedEntry {
  readonly path: string;
  readonly absolutePath: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly sizeBytes?: number;
}

export async function listWorkspaceEntries(
  resolved: ResolvedWorkspacePath,
  maximumDepth: number,
  pattern: string | undefined,
  signal: AbortSignal,
): Promise<readonly TraversedEntry[]> {
  const rootStats = await stat(resolved.absolutePath);
  if (!rootStats.isDirectory()) {
    throw new FileToolError(
      'tool_execution',
      'PATH_NOT_DIRECTORY',
      'The requested workspace path is not a directory.',
      { path: resolved.relativePath },
    );
  }

  const entries: TraversedEntry[] = [];
  let visitedEntries = 0;
  await visitDirectory(resolved.absolutePath, resolved.relativePath, '', 1);
  return entries.sort((left, right) => comparePaths(left.path, right.path));

  async function visitDirectory(
    absoluteDirectory: string,
    workspaceDirectory: string,
    scopeDirectory: string,
    depth: number,
  ): Promise<void> {
    assertNotAborted(signal);
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => comparePaths(left.name, right.name));

    for (const child of children) {
      assertNotAborted(signal);
      visitedEntries += 1;
      if (visitedEntries > MAX_TRAVERSED_ENTRIES) {
        throw new FileToolError(
          'tool_execution',
          'TOO_MANY_FILES',
          'The directory contains too many entries for one file-tool operation.',
        );
      }

      const childAbsolutePath = path.join(absoluteDirectory, child.name);
      const childWorkspacePath = toWorkspacePath(workspaceDirectory, child.name);
      const childScopePath = toWorkspacePath(scopeDirectory, child.name);
      const childRealPath = await assertRealPathInsideWorkspace(
        resolved.rootPath,
        childAbsolutePath,
      );
      const childStats = await stat(childRealPath);
      const symbolicLink = child.isSymbolicLink();
      const type: TraversedEntry['type'] = symbolicLink
        ? 'symlink'
        : childStats.isFile()
          ? 'file'
          : childStats.isDirectory()
            ? 'directory'
            : 'other';

      if (matchesGlob(childScopePath, pattern)) {
        entries.push({
          path: childWorkspacePath,
          absolutePath: childRealPath,
          type,
          ...(childStats.isFile() ? { sizeBytes: childStats.size } : {}),
        });
      }

      if (!symbolicLink && childStats.isDirectory() && depth < maximumDepth) {
        await visitDirectory(childRealPath, childWorkspacePath, childScopePath, depth + 1);
      }
    }
  }
}

export async function collectWorkspaceFiles(
  resolved: ResolvedWorkspacePath,
  pattern: string | undefined,
  signal: AbortSignal,
): Promise<readonly TraversedEntry[]> {
  const rootStats = await stat(resolved.absolutePath);
  if (rootStats.isFile()) {
    return [
      {
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        type: 'file',
        sizeBytes: rootStats.size,
      },
    ];
  }
  if (!rootStats.isDirectory()) {
    throw new FileToolError(
      'tool_execution',
      'PATH_NOT_FILE_OR_DIRECTORY',
      'The requested workspace path is neither a regular file nor a directory.',
      { path: resolved.relativePath },
    );
  }

  const allEntries = await listWorkspaceEntries(resolved, Number.MAX_SAFE_INTEGER, pattern, signal);
  return allEntries.filter((entry) => entry.type === 'file');
}

function comparePaths(left: string, right: string): number {
  const normalizedLeft = process.platform === 'win32' ? left.toLocaleLowerCase('en-US') : left;
  const normalizedRight = process.platform === 'win32' ? right.toLocaleLowerCase('en-US') : right;
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}
