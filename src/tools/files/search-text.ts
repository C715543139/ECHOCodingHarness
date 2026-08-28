import type { ToolDefinition } from '../../contracts/index.js';

import { assertNotAborted, failedExecution, FileToolError } from './errors.js';
import { validateGlob } from './glob.js';
import { limitRecordsHeadTail } from './output.js';
import { resolveWorkspacePath } from './path-safety.js';
import { readTextFile, splitTextLines, withoutLineEnding } from './text.js';
import { collectWorkspaceFiles } from './traversal.js';
import {
  assertInputObject,
  assertOnlyKeys,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredString,
} from './validation.js';

export interface SearchTextInput {
  readonly query: string;
  readonly path?: string;
  readonly glob?: string;
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
}

export interface SearchTextMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface SearchTextData {
  readonly path: string;
  readonly query: string;
  readonly matches: readonly SearchTextMatch[];
  readonly totalMatches: number;
  readonly omittedMatches: number;
  readonly skippedBinaryFiles: number;
}

export const searchTextTool: ToolDefinition<SearchTextInput, SearchTextData> = {
  name: 'search_text',
  description:
    'Search UTF-8 workspace text and return bounded relative file, line, and column matches.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1 },
      path: { type: 'string', description: 'Workspace-relative file or directory; empty is root.' },
      glob: { type: 'string', description: 'Optional *, **, and ? file glob relative to path.' },
      caseSensitive: { type: 'boolean', default: true },
      maxResults: { type: 'integer', minimum: 1, maximum: 10_000, default: 100 },
    },
  },
  async execute(input, context) {
    try {
      assertNotAborted(context.signal);
      assertInputObject(input);
      assertOnlyKeys(input, ['query', 'path', 'glob', 'caseSensitive', 'maxResults']);
      const query = requiredString(input, 'query');
      const requestedPath = optionalString(input, 'path') ?? '';
      const glob = optionalString(input, 'glob');
      validateGlob(glob);
      const caseSensitive = optionalBoolean(input, 'caseSensitive') ?? true;
      const maximumResults = optionalInteger(input, 'maxResults', 1, 10_000) ?? 100;
      const resolved = await resolveWorkspacePath(context.workspaceRoot, requestedPath, {
        allowRoot: true,
        mustExist: true,
        write: false,
      });
      const files = await collectWorkspaceFiles(resolved, glob, context.signal);
      const matches: SearchTextMatch[] = [];
      let skippedBinaryFiles = 0;

      for (const file of files) {
        assertNotAborted(context.signal);
        let text: string;
        try {
          text = (await readTextFile(file.absolutePath, file.path, context.signal)).content;
        } catch (error) {
          if (error instanceof FileToolError && error.code === 'BINARY_FILE' && files.length > 1) {
            skippedBinaryFiles += 1;
            continue;
          }
          throw error;
        }

        const normalizedQuery = caseSensitive ? query : query.toLocaleLowerCase('en-US');
        const lines = splitTextLines(text);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const lineText = withoutLineEnding(lines[lineIndex] as string);
          const searchable = caseSensitive ? lineText : lineText.toLocaleLowerCase('en-US');
          const columnIndex = searchable.indexOf(normalizedQuery);
          if (columnIndex >= 0) {
            matches.push({
              path: file.path,
              line: lineIndex + 1,
              column: columnIndex + 1,
              text: lineText.length <= 500 ? lineText : `${lineText.slice(0, 497)}...`,
            });
          }
        }
      }

      const limited = limitRecordsHeadTail(matches, maximumResults, context.limits.maxOutputChars);
      const truncated = limited.omitted > 0;
      return {
        status: 'completed',
        summary: truncated
          ? `Found ${matches.length} matches and returned ${limited.records.length}.`
          : `Found ${matches.length} text matches.`,
        data: {
          path: resolved.relativePath,
          query,
          matches: limited.records,
          totalMatches: matches.length,
          omittedMatches: limited.omitted,
          skippedBinaryFiles,
        },
        truncated,
      };
    } catch (error) {
      return failedExecution<SearchTextData>(error, 'Search text');
    }
  },
};
