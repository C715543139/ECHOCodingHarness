import type { ToolDefinition } from '../../contracts/index.js';

import { assertNotAborted, failedExecution } from './errors.js';
import { assertInputObject, assertOnlyKeys, requiredString } from './validation.js';
import { writeWorkspaceText } from './write-core.js';

export interface WriteFileInput {
  readonly path: string;
  readonly content: string;
}

export interface WriteFileData {
  readonly path: string;
  readonly created: boolean;
  readonly bytesWritten: number;
  readonly previousBytes: number;
  readonly additions: number;
  readonly deletions: number;
  readonly diff: string;
  readonly omittedDiffChars: number;
}

export const writeFileTool: ToolDefinition<WriteFileInput, WriteFileData> = {
  name: 'write_file',
  description:
    'Create or fully overwrite one workspace-relative UTF-8 text file and return a bounded diff.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', minLength: 1 },
      content: { type: 'string' },
    },
  },
  async execute(input, context) {
    try {
      assertNotAborted(context.signal);
      assertInputObject(input);
      assertOnlyKeys(input, ['path', 'content']);
      const requestedPath = requiredString(input, 'path');
      const content = requiredString(input, 'content', { allowEmpty: true });
      const outcome = await writeWorkspaceText(requestedPath, content, context);
      return {
        status: 'completed',
        summary: outcome.created
          ? `Created ${outcome.path} (${outcome.bytesWritten} bytes).`
          : `Updated ${outcome.path} (${outcome.additions} additions, ${outcome.deletions} deletions).`,
        data: {
          path: outcome.path,
          created: outcome.created,
          bytesWritten: outcome.bytesWritten,
          previousBytes: outcome.previousBytes,
          additions: outcome.additions,
          deletions: outcome.deletions,
          diff: outcome.diff,
          omittedDiffChars: outcome.omittedChars,
        },
        truncated: outcome.truncated,
      };
    } catch (error) {
      return failedExecution<WriteFileData>(error, 'Write file');
    }
  },
};
