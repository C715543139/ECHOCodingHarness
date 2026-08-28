import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext, ToolExecution } from '../../src/contracts/index.js';
import {
  applyPatchTool,
  listFilesTool,
  readFileTool,
  searchTextTool,
  writeFileTool,
  type ApplyPatchData,
  type ListFilesData,
  type ReadFileData,
  type SearchTextData,
  type WriteFileData,
} from '../../src/tools/files/index.js';

function createContext(workspaceRoot: string, maxOutputChars = 10_000): ToolContext {
  return {
    sessionId: 'session-files',
    turnId: 'turn-files',
    stepId: 'step-files',
    toolCallId: 'call-files',
    workspaceRoot,
    signal: new AbortController().signal,
    limits: { timeoutMs: 5_000, maxOutputChars },
  };
}

function completed<T>(
  execution: ToolExecution<T>,
): Extract<ToolExecution<T>, { status: 'completed' }> {
  expect(execution.status).toBe('completed');
  if (execution.status !== 'completed') {
    throw new Error(`${execution.error.code}: ${execution.error.message}`);
  }
  return execution;
}

function failed<T>(execution: ToolExecution<T>): Extract<ToolExecution<T>, { status: 'failed' }> {
  expect(execution.status).toBe('failed');
  if (execution.status !== 'failed') {
    throw new Error('Expected the tool execution to fail.');
  }
  return execution;
}

describe('workspace file tools', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'echo-files-workspace-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('publishes five standalone definitions with closed object schemas', () => {
    const tools = [listFilesTool, searchTextTool, readFileTool, writeFileTool, applyPatchTool];

    expect(tools.map((tool) => tool.name)).toEqual([
      'list_files',
      'search_text',
      'read_file',
      'write_file',
      'apply_patch',
    ]);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });

  describe('list_files', () => {
    it('lists sorted workspace-relative Unicode paths without following nested links', async () => {
      await mkdir(path.join(workspaceRoot, '目录 空格', 'nested'), { recursive: true });
      await writeFile(path.join(workspaceRoot, '目录 空格', '乙.ts'), 'export {};\n');
      await writeFile(path.join(workspaceRoot, '目录 空格', '甲.txt'), 'text\n');
      await writeFile(path.join(workspaceRoot, '目录 空格', 'nested', '深.ts'), 'export {};\n');

      const result = completed<ListFilesData>(
        await listFilesTool.execute(
          { path: '目录 空格', maxDepth: 2, pattern: '**/*.ts' },
          createContext(workspaceRoot),
        ),
      );

      expect(result.data.entries.map((entry) => entry.path)).toEqual([
        '目录 空格/nested/深.ts',
        '目录 空格/乙.ts',
      ]);
      expect(result.data.entries.every((entry) => entry.type === 'file')).toBe(true);
      expect(result.truncated).toBe(false);
    });

    it('returns an empty result for an empty directory and a failure for a missing directory', async () => {
      await mkdir(path.join(workspaceRoot, 'empty'));

      const empty = completed<ListFilesData>(
        await listFilesTool.execute({ path: 'empty' }, createContext(workspaceRoot)),
      );
      const missing = failed<ListFilesData>(
        await listFilesTool.execute({ path: 'missing' }, createContext(workspaceRoot)),
      );

      expect(empty.data).toMatchObject({ entries: [], totalEntries: 0, omittedEntries: 0 });
      expect(missing.error).toMatchObject({ category: 'tool_execution', code: 'PATH_NOT_FOUND' });
    });

    it('validates a glob even when the selected directory is empty', async () => {
      await mkdir(path.join(workspaceRoot, 'empty'));

      const result = failed<ListFilesData>(
        await listFilesTool.execute({ path: 'empty', pattern: '' }, createContext(workspaceRoot)),
      );

      expect(result.error).toMatchObject({
        category: 'invalid_tool_input',
        code: 'INVALID_FILE_TOOL_INPUT',
      });
    });

    it('keeps both the first and last entries when bounded output is truncated', async () => {
      await Promise.all(
        Array.from({ length: 12 }, async (_, index) =>
          writeFile(path.join(workspaceRoot, `file-${String(index).padStart(2, '0')}.txt`), 'x'),
        ),
      );

      const result = completed<ListFilesData>(
        await listFilesTool.execute({}, createContext(workspaceRoot, 180)),
      );

      expect(result.truncated).toBe(true);
      expect(result.data.omittedEntries).toBeGreaterThan(0);
      expect(result.data.entries.at(0)?.path).toBe('file-00.txt');
      expect(result.data.entries.at(-1)?.path).toBe('file-11.txt');
    });
  });

  describe('search_text', () => {
    it('searches CRLF text with stable relative locations and glob filtering', async () => {
      await mkdir(path.join(workspaceRoot, '源 码'));
      await writeFile(
        path.join(workspaceRoot, '源 码', '一.ts'),
        'first\r\n目标 value\r\nlast\r\n',
      );
      await writeFile(path.join(workspaceRoot, '源 码', '二.txt'), '目标 ignored\n');

      const result = completed<SearchTextData>(
        await searchTextTool.execute(
          { query: '目标', path: '源 码', glob: '**/*.ts' },
          createContext(workspaceRoot),
        ),
      );

      expect(result.data.matches).toEqual([
        {
          path: '源 码/一.ts',
          line: 2,
          column: 1,
          text: '目标 value',
        },
      ]);
      expect(result.data.skippedBinaryFiles).toBe(0);
    });

    it('rejects an explicitly selected binary file and skips binaries in a directory search', async () => {
      await writeFile(path.join(workspaceRoot, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
      await writeFile(path.join(workspaceRoot, 'text.txt'), 'needle\n');

      const explicit = failed<SearchTextData>(
        await searchTextTool.execute(
          { query: 'needle', path: 'binary.bin' },
          createContext(workspaceRoot),
        ),
      );
      const directory = completed<SearchTextData>(
        await searchTextTool.execute({ query: 'needle' }, createContext(workspaceRoot)),
      );

      expect(explicit.error.code).toBe('BINARY_FILE');
      expect(directory.data.matches).toHaveLength(1);
      expect(directory.data.skippedBinaryFiles).toBe(1);
    });

    it('preserves head and tail matches when maxResults truncates the result', async () => {
      await writeFile(
        path.join(workspaceRoot, 'many.txt'),
        Array.from({ length: 8 }, (_, index) => `needle ${index}`).join('\n'),
      );

      const result = completed<SearchTextData>(
        await searchTextTool.execute(
          { query: 'needle', maxResults: 3 },
          createContext(workspaceRoot, 10_000),
        ),
      );

      expect(result.truncated).toBe(true);
      expect(result.data.totalMatches).toBe(8);
      expect(result.data.omittedMatches).toBe(5);
      expect(result.data.matches.map((match) => match.line)).toEqual([1, 2, 8]);
    });
  });

  describe('read_file', () => {
    it('reads empty files and preserves CRLF within a selected line range', async () => {
      await writeFile(path.join(workspaceRoot, 'empty.txt'), '');
      await writeFile(path.join(workspaceRoot, 'crlf.txt'), '第一行\r\nsecond\r\n第三行\r\n');

      const empty = completed<ReadFileData>(
        await readFileTool.execute({ path: 'empty.txt' }, createContext(workspaceRoot)),
      );
      const crlf = completed<ReadFileData>(
        await readFileTool.execute(
          { path: 'crlf.txt', startLine: 2, endLine: 3 },
          createContext(workspaceRoot),
        ),
      );

      expect(empty.data).toMatchObject({ content: '', sizeBytes: 0, totalLines: 0 });
      expect(crlf.data).toMatchObject({
        content: 'second\r\n第三行\r\n',
        startLine: 2,
        endLine: 3,
        totalLines: 3,
      });
    });

    it('rejects missing, directory, and binary targets without exposing absolute paths', async () => {
      await mkdir(path.join(workspaceRoot, 'directory'));
      await writeFile(path.join(workspaceRoot, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]));

      const missing = failed<ReadFileData>(
        await readFileTool.execute({ path: 'missing.txt' }, createContext(workspaceRoot)),
      );
      const directory = failed<ReadFileData>(
        await readFileTool.execute({ path: 'directory' }, createContext(workspaceRoot)),
      );
      const binary = failed<ReadFileData>(
        await readFileTool.execute({ path: 'binary.bin' }, createContext(workspaceRoot)),
      );

      expect(missing.error.code).toBe('PATH_NOT_FOUND');
      expect(directory.error.code).toBe('PATH_NOT_FILE');
      expect(binary.error.code).toBe('BINARY_FILE');
      expect(JSON.stringify([missing, directory, binary])).not.toContain(workspaceRoot);
    });

    it('marks truncation and retains the exact head and tail of large text', async () => {
      const content = `${'HEAD'.repeat(30)} middle ${'TAIL'.repeat(30)}`;
      await writeFile(path.join(workspaceRoot, 'large.txt'), content);

      const result = completed<ReadFileData>(
        await readFileTool.execute({ path: 'large.txt' }, createContext(workspaceRoot, 90)),
      );

      expect(result.truncated).toBe(true);
      expect(result.data.content.length).toBeLessThanOrEqual(90);
      expect(result.data.content.startsWith('HEAD')).toBe(true);
      expect(result.data.content.endsWith('TAIL')).toBe(true);
      expect(result.data.omittedChars).toBeGreaterThan(0);
    });
  });

  describe('write_file', () => {
    it('creates and overwrites Unicode paths with a bounded structured diff', async () => {
      await mkdir(path.join(workspaceRoot, '输出 空格'));

      const created = completed<WriteFileData>(
        await writeFileTool.execute(
          { path: '输出 空格/结果.txt', content: '旧值\r\n' },
          createContext(workspaceRoot),
        ),
      );
      const updated = completed<WriteFileData>(
        await writeFileTool.execute(
          { path: '输出 空格/结果.txt', content: '新值\r\n第二行\r\n' },
          createContext(workspaceRoot),
        ),
      );

      expect(created.data).toMatchObject({ created: true, path: '输出 空格/结果.txt' });
      expect(updated.data).toMatchObject({ created: false, additions: 2, deletions: 1 });
      expect(updated.data.diff).toContain('--- a/输出 空格/结果.txt');
      expect(updated.data.diff).toContain('+新值');
      expect(await readFile(path.join(workspaceRoot, '输出 空格', '结果.txt'), 'utf8')).toBe(
        '新值\r\n第二行\r\n',
      );
    });

    it('fails for a missing parent and rejects case-insensitive .git writes', async () => {
      await mkdir(path.join(workspaceRoot, '.GIT'));

      const missingParent = failed<WriteFileData>(
        await writeFileTool.execute(
          { path: 'missing/file.txt', content: 'nope' },
          createContext(workspaceRoot),
        ),
      );
      const gitWrite = failed<WriteFileData>(
        await writeFileTool.execute(
          { path: '.GIT/config', content: 'nope' },
          createContext(workspaceRoot),
        ),
      );

      expect(missingParent.error.code).toBe('PARENT_NOT_FOUND');
      expect(gitWrite.error).toMatchObject({
        category: 'workspace_violation',
        code: 'GIT_WRITE_DENIED',
      });
    });

    it('can overwrite a file with empty text and explicitly bounds a large diff', async () => {
      await writeFile(path.join(workspaceRoot, 'bounded.txt'), 'old line\n');
      const largeContent = `${'NEW-HEAD'.repeat(30)}\n${'NEW-TAIL'.repeat(30)}\n`;

      const bounded = completed<WriteFileData>(
        await writeFileTool.execute(
          { path: 'bounded.txt', content: largeContent },
          createContext(workspaceRoot, 100),
        ),
      );
      const emptied = completed<WriteFileData>(
        await writeFileTool.execute(
          { path: 'bounded.txt', content: '' },
          createContext(workspaceRoot),
        ),
      );

      expect(bounded.truncated).toBe(true);
      expect(bounded.data.diff.length).toBeLessThanOrEqual(100);
      expect(bounded.data.diff.startsWith('--- a/bounded.txt')).toBe(true);
      expect(bounded.data.diff.endsWith('NEW-TAIL\n')).toBe(true);
      expect(bounded.data.omittedDiffChars).toBeGreaterThan(0);
      expect(emptied.data).toMatchObject({ additions: 0, deletions: 2, bytesWritten: 0 });
      expect(await readFile(path.join(workspaceRoot, 'bounded.txt'), 'utf8')).toBe('');
    });

    it('does not write after cancellation', async () => {
      const controller = new AbortController();
      controller.abort();
      const context = { ...createContext(workspaceRoot), signal: controller.signal };

      const result = failed<WriteFileData>(
        await writeFileTool.execute({ path: 'cancelled.txt', content: 'nope' }, context),
      );

      expect(result.error).toMatchObject({ category: 'cancelled', code: 'FILE_TOOL_CANCELLED' });
      await expect(readFile(path.join(workspaceRoot, 'cancelled.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe('apply_patch', () => {
    it('applies all structured edits atomically and returns the resulting diff', async () => {
      await writeFile(path.join(workspaceRoot, 'patch.txt'), 'alpha\r\nbeta\r\nbeta\r\nomega\r\n');

      const result = completed<ApplyPatchData>(
        await applyPatchTool.execute(
          {
            path: 'patch.txt',
            edits: [
              { oldText: 'alpha', newText: 'ALPHA' },
              { oldText: 'beta', newText: 'BETA', replaceAll: true },
            ],
          },
          createContext(workspaceRoot),
        ),
      );

      expect(result.data).toMatchObject({ path: 'patch.txt', appliedEdits: 2, replacements: 3 });
      expect(result.data.diff).toContain('-alpha');
      expect(result.data.diff).toContain('+ALPHA');
      expect(await readFile(path.join(workspaceRoot, 'patch.txt'), 'utf8')).toBe(
        'ALPHA\r\nBETA\r\nBETA\r\nomega\r\n',
      );
    });

    it('treats replacement dollar sequences as literal patch content', async () => {
      await writeFile(path.join(workspaceRoot, 'literal.txt'), 'before value after\n');

      const result = completed<ApplyPatchData>(
        await applyPatchTool.execute(
          {
            path: 'literal.txt',
            edits: [{ oldText: 'value', newText: "$&-$`-$'" }],
          },
          createContext(workspaceRoot),
        ),
      );

      expect(result.data.replacements).toBe(1);
      expect(await readFile(path.join(workspaceRoot, 'literal.txt'), 'utf8')).toBe(
        "before $&-$`-$' after\n",
      );
    });

    it('leaves the file unchanged when any edit is missing or ambiguous', async () => {
      const original = 'same\nsame\n';
      await writeFile(path.join(workspaceRoot, 'conflict.txt'), original);

      const ambiguous = failed<ApplyPatchData>(
        await applyPatchTool.execute(
          { path: 'conflict.txt', edits: [{ oldText: 'same', newText: 'changed' }] },
          createContext(workspaceRoot),
        ),
      );
      const missing = failed<ApplyPatchData>(
        await applyPatchTool.execute(
          {
            path: 'conflict.txt',
            edits: [
              { oldText: 'same\nsame\n', newText: 'first\nsame\n' },
              { oldText: 'absent', newText: 'never written' },
            ],
          },
          createContext(workspaceRoot),
        ),
      );

      expect(ambiguous.error.code).toBe('PATCH_CONTEXT_AMBIGUOUS');
      expect(missing.error.code).toBe('PATCH_CONTEXT_NOT_FOUND');
      expect(await readFile(path.join(workspaceRoot, 'conflict.txt'), 'utf8')).toBe(original);
    });
  });

  describe('workspace boundary attacks', () => {
    it.each([
      ['parent traversal', '../escape.txt'],
      ['Windows parent traversal', '..\\escape.txt'],
      ['POSIX absolute path', '/tmp/escape.txt'],
      ['UNC path', '\\\\server\\share\\escape.txt'],
      ['Windows device path', '\\\\?\\C:\\escape.txt'],
      ['Windows alternate data stream', 'safe.txt:secret'],
      ['Windows reserved device name', 'CON.txt'],
      ['Windows trailing-dot alias', '.git./config'],
    ])('rejects %s', async (_label, attemptedPath) => {
      const result = failed<ReadFileData>(
        await readFileTool.execute({ path: attemptedPath }, createContext(workspaceRoot)),
      );

      expect(result.error.category).toBe('workspace_violation');
    });

    it('rejects an absolute path even when it points back inside the workspace', async () => {
      const absolutePath = path.join(workspaceRoot, 'inside.txt');
      await writeFile(absolutePath, 'inside');

      const result = failed<ReadFileData>(
        await readFileTool.execute({ path: absolutePath }, createContext(workspaceRoot)),
      );

      expect(result.error.code).toBe('ABSOLUTE_PATH_DENIED');
    });

    it('rejects existing targets and new parents that traverse an external link', async () => {
      const externalRoot = await mkdtemp(path.join(tmpdir(), 'echo-files-external-'));
      try {
        await writeFile(path.join(externalRoot, 'secret.txt'), 'outside');
        await symlink(
          externalRoot,
          path.join(workspaceRoot, 'outside-link'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );

        const read = failed<ReadFileData>(
          await readFileTool.execute(
            { path: 'outside-link/secret.txt' },
            createContext(workspaceRoot),
          ),
        );
        const write = failed<WriteFileData>(
          await writeFileTool.execute(
            { path: 'outside-link/new.txt', content: 'escape' },
            createContext(workspaceRoot),
          ),
        );
        const list = failed<ListFilesData>(
          await listFilesTool.execute({}, createContext(workspaceRoot)),
        );

        expect(
          [read, write, list].every((entry) => entry.error.code === 'LINK_OUTSIDE_WORKSPACE'),
        ).toBe(true);
        await expect(readFile(path.join(externalRoot, 'new.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(externalRoot, { recursive: true, force: true });
      }
    });

    it('rejects a new target beneath a broken directory link', async () => {
      const vanishedTarget = await mkdtemp(path.join(tmpdir(), 'echo-files-vanished-'));
      await symlink(
        vanishedTarget,
        path.join(workspaceRoot, 'broken-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await rm(vanishedTarget, { recursive: true, force: true });

      const result = failed<WriteFileData>(
        await writeFileTool.execute(
          { path: 'broken-link/new.txt', content: 'must not write' },
          createContext(workspaceRoot),
        ),
      );

      expect(result.error).toMatchObject({
        category: 'workspace_violation',
        code: 'LINK_TARGET_UNAVAILABLE',
      });
    });

    it.runIf(process.platform === 'win32')(
      'accepts workspace-root casing changes using Windows case-insensitive semantics',
      async () => {
        await writeFile(path.join(workspaceRoot, 'case.txt'), 'case-safe');
        const driveChangedRoot = `${workspaceRoot[0]?.toUpperCase() === workspaceRoot[0] ? workspaceRoot[0]?.toLowerCase() : workspaceRoot[0]?.toUpperCase()}${workspaceRoot.slice(1)}`;

        const result = completed<ReadFileData>(
          await readFileTool.execute({ path: 'case.txt' }, createContext(driveChangedRoot)),
        );

        expect(result.data.content).toBe('case-safe');
      },
    );
  });
});
