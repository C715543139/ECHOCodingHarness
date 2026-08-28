import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ToolContext } from '../../contracts/index.js';

import { createDiff, type DiffResult } from './diff.js';
import { assertNotAborted, FileToolError } from './errors.js';
import { resolveWorkspacePath, type ResolvedWorkspacePath } from './path-safety.js';
import { readTextFile } from './text.js';

export interface WriteOutcome extends DiffResult {
  readonly path: string;
  readonly created: boolean;
  readonly bytesWritten: number;
  readonly previousBytes: number;
}

export async function writeWorkspaceText(
  requestedPath: string,
  content: string,
  context: ToolContext,
  expectedPreviousContent?: string,
): Promise<WriteOutcome> {
  if (content.includes('\0')) {
    throw new FileToolError(
      'invalid_tool_input',
      'BINARY_CONTENT_DENIED',
      'Text file tools cannot write content containing null bytes.',
    );
  }

  const initial = await resolveWorkspacePath(context.workspaceRoot, requestedPath, {
    allowRoot: false,
    mustExist: false,
    write: true,
  });
  const previous = initial.exists
    ? await readTextFile(initial.absolutePath, initial.relativePath, context.signal)
    : { content: '', sizeBytes: 0 };
  if (expectedPreviousContent !== undefined && previous.content !== expectedPreviousContent) {
    throw new FileToolError(
      'tool_execution',
      'FILE_CHANGED_DURING_PATCH',
      'The file changed while the patch was being prepared; no patch was written.',
      { path: initial.relativePath },
    );
  }
  const diff = createDiff(
    previous.content,
    content,
    initial.relativePath,
    context.limits.maxOutputChars,
  );

  assertNotAborted(context.signal);
  const revalidated = await resolveWorkspacePath(context.workspaceRoot, requestedPath, {
    allowRoot: false,
    mustExist: initial.exists,
    write: true,
  });
  assertPathUnchanged(initial, revalidated);
  await writeFile(revalidated.absolutePath, content, { encoding: 'utf8', signal: context.signal });

  return {
    path: initial.relativePath,
    created: !initial.exists,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
    previousBytes: previous.sizeBytes,
    ...diff,
  };
}

function assertPathUnchanged(
  initial: ResolvedWorkspacePath,
  revalidated: ResolvedWorkspacePath,
): void {
  const initialPath = normalizeComparisonPath(initial.absolutePath);
  const revalidatedPath = normalizeComparisonPath(revalidated.absolutePath);
  if (initial.exists !== revalidated.exists || initialPath !== revalidatedPath) {
    throw new FileToolError(
      'workspace_violation',
      'PATH_CHANGED_DURING_OPERATION',
      'The target path changed while the file operation was being prepared. Retry the operation.',
      { path: initial.relativePath },
    );
  }
}

function normalizeComparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
