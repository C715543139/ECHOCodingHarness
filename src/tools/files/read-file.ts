import type { ToolDefinition } from '../../contracts/index.js';

import { assertNotAborted, failedExecution, FileToolError } from './errors.js';
import { resolveWorkspacePath } from './path-safety.js';
import { readTextFile, splitTextLines, truncateHeadTail } from './text.js';
import {
  assertInputObject,
  assertOnlyKeys,
  optionalInteger,
  requiredString,
} from './validation.js';

export interface ReadFileInput {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ReadFileData {
  readonly path: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly omittedChars: number;
}

export const readFileTool: ToolDefinition<ReadFileInput, ReadFileData> = {
  name: 'read_file',
  description: 'Read bounded UTF-8 text from one workspace-relative regular file.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1 },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    },
  },
  async execute(input, context) {
    try {
      assertNotAborted(context.signal);
      assertInputObject(input);
      assertOnlyKeys(input, ['path', 'startLine', 'endLine']);
      const requestedPath = requiredString(input, 'path');
      const startLine = optionalInteger(input, 'startLine', 1, Number.MAX_SAFE_INTEGER) ?? 1;
      const requestedEndLine = optionalInteger(input, 'endLine', 1, Number.MAX_SAFE_INTEGER);
      if (requestedEndLine !== undefined && requestedEndLine < startLine) {
        throw new FileToolError(
          'invalid_tool_input',
          'INVALID_FILE_TOOL_INPUT',
          'Input field "endLine" must be greater than or equal to "startLine".',
        );
      }

      const resolved = await resolveWorkspacePath(context.workspaceRoot, requestedPath, {
        allowRoot: false,
        mustExist: true,
        write: false,
      });
      const file = await readTextFile(resolved.absolutePath, resolved.relativePath, context.signal);
      const lines = splitTextLines(file.content);
      if (lines.length > 0 && startLine > lines.length) {
        throw new FileToolError(
          'invalid_tool_input',
          'LINE_RANGE_OUTSIDE_FILE',
          'The requested starting line is beyond the end of the file.',
          { path: resolved.relativePath, totalLines: lines.length },
        );
      }
      const endLine =
        lines.length === 0 ? 0 : Math.min(requestedEndLine ?? lines.length, lines.length);
      const selected = lines.slice(startLine - 1, endLine).join('');
      const bounded = truncateHeadTail(selected, context.limits.maxOutputChars);
      return {
        status: 'completed',
        summary: bounded.truncated
          ? `Read lines ${startLine}-${endLine} from ${resolved.relativePath} with truncation.`
          : `Read lines ${lines.length === 0 ? 0 : startLine}-${endLine} from ${resolved.relativePath}.`,
        data: {
          path: resolved.relativePath,
          content: bounded.content,
          sizeBytes: file.sizeBytes,
          totalLines: lines.length,
          startLine: lines.length === 0 ? 0 : startLine,
          endLine,
          omittedChars: bounded.omittedChars,
        },
        truncated: bounded.truncated,
      };
    } catch (error) {
      return failedExecution<ReadFileData>(error, 'Read file');
    }
  },
};
