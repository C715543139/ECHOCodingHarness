import type { ToolDefinition } from '../../contracts/index.js';

import { assertNotAborted, failedExecution, FileToolError } from './errors.js';
import { resolveWorkspacePath } from './path-safety.js';
import { readTextFile } from './text.js';
import {
  assertInputObject,
  assertOnlyKeys,
  optionalBoolean,
  requiredString,
} from './validation.js';
import { writeWorkspaceText } from './write-core.js';

export interface PatchEdit {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean;
}

export interface ApplyPatchInput {
  readonly path: string;
  readonly edits: readonly PatchEdit[];
}

export interface ApplyPatchData {
  readonly path: string;
  readonly appliedEdits: number;
  readonly replacements: number;
  readonly bytesWritten: number;
  readonly additions: number;
  readonly deletions: number;
  readonly diff: string;
  readonly omittedDiffChars: number;
}

export const applyPatchTool: ToolDefinition<ApplyPatchInput, ApplyPatchData> = {
  name: 'apply_patch',
  description:
    'Apply ordered, exact text replacements to one workspace UTF-8 file; ambiguous edits fail safely.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'edits'],
    properties: {
      path: { type: 'string', minLength: 1 },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['oldText', 'newText'],
          properties: {
            oldText: { type: 'string', minLength: 1 },
            newText: { type: 'string' },
            replaceAll: { type: 'boolean', default: false },
          },
        },
      },
    },
  },
  async execute(input, context) {
    try {
      assertNotAborted(context.signal);
      assertInputObject(input);
      assertOnlyKeys(input, ['path', 'edits']);
      const requestedPath = requiredString(input, 'path');
      const edits = parseEdits(input.edits);
      const resolved = await resolveWorkspacePath(context.workspaceRoot, requestedPath, {
        allowRoot: false,
        mustExist: true,
        write: true,
      });
      const file = await readTextFile(resolved.absolutePath, resolved.relativePath, context.signal);
      let nextContent = file.content;
      let replacements = 0;

      for (const edit of edits) {
        assertNotAborted(context.signal);
        const occurrences = countOccurrences(nextContent, edit.oldText);
        if (occurrences === 0) {
          throw new FileToolError(
            'tool_execution',
            'PATCH_CONTEXT_NOT_FOUND',
            'A patch edit did not match the current file content; no changes were written.',
            { path: resolved.relativePath },
          );
        }
        if (occurrences > 1 && edit.replaceAll !== true) {
          throw new FileToolError(
            'tool_execution',
            'PATCH_CONTEXT_AMBIGUOUS',
            'A patch edit matched more than once; use replaceAll or provide more context.',
            { path: resolved.relativePath, occurrences },
          );
        }
        nextContent =
          edit.replaceAll === true
            ? nextContent.split(edit.oldText).join(edit.newText)
            : replaceFirstLiteral(nextContent, edit.oldText, edit.newText);
        replacements += edit.replaceAll === true ? occurrences : 1;
      }

      const outcome = await writeWorkspaceText(requestedPath, nextContent, context, file.content);
      return {
        status: 'completed',
        summary: `Applied ${edits.length} edits (${replacements} replacements) to ${outcome.path}.`,
        data: {
          path: outcome.path,
          appliedEdits: edits.length,
          replacements,
          bytesWritten: outcome.bytesWritten,
          additions: outcome.additions,
          deletions: outcome.deletions,
          diff: outcome.diff,
          omittedDiffChars: outcome.omittedChars,
        },
        truncated: outcome.truncated,
      };
    } catch (error) {
      return failedExecution<ApplyPatchData>(error, 'Apply patch');
    }
  },
};

function parseEdits(value: unknown): readonly PatchEdit[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new FileToolError(
      'invalid_tool_input',
      'INVALID_FILE_TOOL_INPUT',
      'Input field "edits" must contain between 1 and 100 patch edits.',
    );
  }

  return value.map((candidate) => {
    assertInputObject(candidate);
    assertOnlyKeys(candidate, ['oldText', 'newText', 'replaceAll']);
    const oldText = requiredString(candidate, 'oldText');
    const newText = requiredString(candidate, 'newText', { allowEmpty: true });
    const replaceAll = optionalBoolean(candidate, 'replaceAll');
    if (oldText === newText) {
      throw new FileToolError(
        'invalid_tool_input',
        'INVALID_FILE_TOOL_INPUT',
        'A patch edit must change its matched text.',
      );
    }
    return { oldText, newText, ...(replaceAll === undefined ? {} : { replaceAll }) };
  });
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let position = 0;
  while (position <= content.length - search.length) {
    const match = content.indexOf(search, position);
    if (match < 0) {
      break;
    }
    count += 1;
    position = match + search.length;
  }
  return count;
}

function replaceFirstLiteral(content: string, search: string, replacement: string): string {
  const position = content.indexOf(search);
  return `${content.slice(0, position)}${replacement}${content.slice(position + search.length)}`;
}
