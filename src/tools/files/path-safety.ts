import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { FileToolError } from './errors.js';

export interface ResolvedWorkspacePath {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly exists: boolean;
}

interface ResolveOptions {
  readonly allowRoot: boolean;
  readonly mustExist: boolean;
  readonly write: boolean;
}

export async function resolveWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
  options: ResolveOptions,
): Promise<ResolvedWorkspacePath> {
  const rootPath = await resolveWorkspaceRoot(workspaceRoot);
  const segments = validateRelativePath(inputPath, options.allowRoot);
  const relativePath = segments.join('/');

  if (options.write) {
    assertGitWriteAllowed(segments, relativePath);
  }

  const lexicalPath = path.join(rootPath, ...segments);
  ensureInsideWorkspace(rootPath, lexicalPath, 'PATH_OUTSIDE_WORKSPACE');

  let targetExists = true;
  try {
    await lstat(lexicalPath);
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      targetExists = false;
    } else {
      throw error;
    }
  }

  if (targetExists) {
    try {
      const targetPath = await realpath(lexicalPath);
      ensureInsideWorkspace(rootPath, targetPath, 'LINK_OUTSIDE_WORKSPACE');
      if (options.write) {
        assertCanonicalGitWriteAllowed(rootPath, targetPath, relativePath);
      }
      return { rootPath, relativePath, absolutePath: targetPath, exists: true };
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) {
        throw new FileToolError(
          'workspace_violation',
          'LINK_TARGET_UNAVAILABLE',
          'The requested path contains a symbolic link or junction whose target is unavailable.',
          { path: relativePath },
        );
      }
      throw error;
    }
  }

  if (options.mustExist) {
    throw new FileToolError(
      'tool_execution',
      'PATH_NOT_FOUND',
      'The requested workspace path does not exist.',
      { path: relativePath },
    );
  }

  const parentPath = path.dirname(lexicalPath);
  let parentRealPath: string;
  try {
    parentRealPath = await realpath(parentPath);
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      try {
        await lstat(parentPath);
        throw new FileToolError(
          'workspace_violation',
          'LINK_TARGET_UNAVAILABLE',
          'The requested path contains a symbolic link or junction whose target is unavailable.',
          { path: relativePath },
        );
      } catch (parentError) {
        if (parentError instanceof FileToolError) {
          throw parentError;
        }
        if (!isFileSystemError(parentError, 'ENOENT')) {
          throw parentError;
        }
      }
      throw new FileToolError(
        'tool_execution',
        'PARENT_NOT_FOUND',
        'The parent directory for the requested workspace path does not exist.',
        { path: relativePath },
      );
    }
    throw error;
  }

  ensureInsideWorkspace(rootPath, parentRealPath, 'LINK_OUTSIDE_WORKSPACE');
  const targetPath = path.join(parentRealPath, path.basename(lexicalPath));
  if (options.write) {
    assertCanonicalGitWriteAllowed(rootPath, targetPath, relativePath);
  }
  const parentStats = await stat(parentRealPath);
  if (!parentStats.isDirectory()) {
    throw new FileToolError(
      'tool_execution',
      'PARENT_NOT_DIRECTORY',
      'The parent of the requested workspace path is not a directory.',
      { path: relativePath },
    );
  }

  return {
    rootPath,
    relativePath,
    absolutePath: targetPath,
    exists: false,
  };
}

export async function assertRealPathInsideWorkspace(
  rootPath: string,
  candidatePath: string,
): Promise<string> {
  const targetPath = await realpath(candidatePath);
  ensureInsideWorkspace(rootPath, targetPath, 'LINK_OUTSIDE_WORKSPACE');
  return targetPath;
}

export function ensureInsideWorkspace(
  rootPath: string,
  candidatePath: string,
  code: 'PATH_OUTSIDE_WORKSPACE' | 'LINK_OUTSIDE_WORKSPACE',
): void {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FileToolError(
      'workspace_violation',
      code,
      code === 'LINK_OUTSIDE_WORKSPACE'
        ? 'A symbolic link or directory junction points outside the workspace.'
        : 'The requested path is outside the workspace.',
    );
  }
}

export function toWorkspacePath(...segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .join('/')
    .replaceAll('\\', '/');
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
  if (workspaceRoot.length === 0) {
    throw new FileToolError(
      'configuration',
      'WORKSPACE_ROOT_INVALID',
      'The workspace root is not configured.',
    );
  }

  try {
    const rootPath = await realpath(path.resolve(workspaceRoot));
    const rootStats = await stat(rootPath);
    if (!rootStats.isDirectory()) {
      throw new FileToolError(
        'configuration',
        'WORKSPACE_ROOT_INVALID',
        'The configured workspace root is not a directory.',
      );
    }
    return rootPath;
  } catch (error) {
    if (error instanceof FileToolError) {
      throw error;
    }
    throw new FileToolError(
      'configuration',
      'WORKSPACE_ROOT_INVALID',
      'The configured workspace root does not exist or cannot be accessed.',
    );
  }
}

function validateRelativePath(inputPath: string, allowRoot: boolean): string[] {
  if (inputPath.includes('\0')) {
    throw workspaceViolation('INVALID_PATH', 'Workspace paths cannot contain null bytes.');
  }
  if (
    path.isAbsolute(inputPath) ||
    path.win32.isAbsolute(inputPath) ||
    path.posix.isAbsolute(inputPath) ||
    /^[A-Za-z]:/u.test(inputPath)
  ) {
    throw workspaceViolation(
      'ABSOLUTE_PATH_DENIED',
      'File tools accept only workspace-relative paths.',
    );
  }

  const segments = inputPath
    .split(/[\\/]+/u)
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw workspaceViolation(
      'PATH_TRAVERSAL_DENIED',
      'Parent path segments are not allowed in workspace paths.',
    );
  }
  if (segments[0] === '~') {
    throw workspaceViolation(
      'HOME_PATH_DENIED',
      'Home-directory abbreviations are not allowed in workspace paths.',
    );
  }
  if (segments.some((segment) => segment.includes(':'))) {
    throw workspaceViolation(
      'WINDOWS_ALTERNATE_STREAM_DENIED',
      'Colon characters are not allowed in workspace path segments.',
    );
  }
  if (segments.some((segment) => /[ .]$/u.test(segment))) {
    throw workspaceViolation(
      'WINDOWS_AMBIGUOUS_PATH_DENIED',
      'Workspace path segments cannot end with a space or dot.',
    );
  }
  if (segments.some(isWindowsDeviceName)) {
    throw workspaceViolation(
      'WINDOWS_DEVICE_PATH_DENIED',
      'Windows reserved device names are not allowed in workspace paths.',
    );
  }
  if (segments.length === 0 && !allowRoot) {
    throw workspaceViolation(
      'EMPTY_PATH_DENIED',
      'This file tool requires a non-empty relative path.',
    );
  }
  return segments;
}

function isWindowsDeviceName(segment: string): boolean {
  const baseName = trimWindowsPathSuffix(segment).split('.')[0]?.toLocaleUpperCase('en-US') ?? '';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)$/u.test(baseName);
}

function trimWindowsPathSuffix(segment: string): string {
  let end = segment.length;
  while (end > 0) {
    const code = segment.charCodeAt(end - 1);
    if (code !== 32 && code !== 46) break;
    end -= 1;
  }
  return segment.slice(0, end);
}

function assertCanonicalGitWriteAllowed(
  rootPath: string,
  targetPath: string,
  requestedRelativePath: string,
): void {
  const canonicalSegments = path.relative(rootPath, targetPath).split(/[\\/]+/u);
  assertGitWriteAllowed(canonicalSegments, requestedRelativePath);
}

function assertGitWriteAllowed(segments: readonly string[], requestedRelativePath: string): void {
  if (
    segments.some((segment) => trimWindowsPathSuffix(segment).toLocaleLowerCase('en-US') === '.git')
  ) {
    throw new FileToolError(
      'workspace_violation',
      'GIT_WRITE_DENIED',
      'File tools cannot write inside .git.',
      { path: requestedRelativePath },
    );
  }
}

function workspaceViolation(code: string, message: string): FileToolError {
  return new FileToolError('workspace_violation', code, message);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
