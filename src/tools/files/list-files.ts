import type { ToolDefinition } from '../../contracts/index.js';

import { assertNotAborted, failedExecution } from './errors.js';
import { validateGlob } from './glob.js';
import { limitRecordsHeadTail } from './output.js';
import { resolveWorkspacePath } from './path-safety.js';
import { listWorkspaceEntries } from './traversal.js';
import {
  assertInputObject,
  assertOnlyKeys,
  optionalInteger,
  optionalString,
} from './validation.js';

export interface ListFilesInput {
  readonly path?: string;
  readonly maxDepth?: number;
  readonly pattern?: string;
}

export interface ListFileEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly sizeBytes?: number;
}

export interface ListFilesData {
  readonly path: string;
  readonly entries: readonly ListFileEntry[];
  readonly totalEntries: number;
  readonly omittedEntries: number;
}

export const listFilesTool: ToolDefinition<ListFilesInput, ListFilesData> = {
  name: 'list_files',
  description:
    'List bounded, sorted workspace-relative files and directories without following links.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Workspace-relative directory; empty means the root.' },
      maxDepth: { type: 'integer', minimum: 1, maximum: 64, default: 4 },
      pattern: { type: 'string', description: 'Optional *, **, and ? glob relative to path.' },
    },
  },
  async execute(input, context) {
    try {
      assertNotAborted(context.signal);
      assertInputObject(input);
      assertOnlyKeys(input, ['path', 'maxDepth', 'pattern']);
      const requestedPath = optionalString(input, 'path') ?? '';
      const maximumDepth = optionalInteger(input, 'maxDepth', 1, 64) ?? 4;
      const pattern = optionalString(input, 'pattern');
      validateGlob(pattern);
      const resolved = await resolveWorkspacePath(context.workspaceRoot, requestedPath, {
        allowRoot: true,
        mustExist: true,
        write: false,
      });
      const allEntries = await listWorkspaceEntries(
        resolved,
        maximumDepth,
        pattern,
        context.signal,
      );
      const limited = limitRecordsHeadTail(
        allEntries.map(({ path, type, sizeBytes }) => ({
          path,
          type,
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        })),
        allEntries.length,
        context.limits.maxOutputChars,
      );
      const truncated = limited.omitted > 0;
      return {
        status: 'completed',
        summary: truncated
          ? `Listed ${limited.records.length} of ${allEntries.length} workspace entries.`
          : `Listed ${allEntries.length} workspace entries.`,
        data: {
          path: resolved.relativePath,
          entries: limited.records,
          totalEntries: allEntries.length,
          omittedEntries: limited.omitted,
        },
        truncated,
      };
    } catch (error) {
      return failedExecution<ListFilesData>(error, 'List files');
    }
  },
};
