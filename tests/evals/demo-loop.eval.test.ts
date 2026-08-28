import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  completedToolNames,
  createEvalWorkspace,
  DEFAULT_EVAL_TOOLS,
  formatEvalSummary,
  jsonlHasContextProjection,
  removeEvalWorkspace,
  runOfflineEval,
  terminalToolEvents,
  textTurn,
  toolTurn,
} from './eval-harness.js';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => removeEvalWorkspace(workspace)));
});

describeWindows('offline Fake Provider eval: demo-loop', () => {
  it('records a six-tool repair loop with JSONL, context projection, and a stable summary', async () => {
    const workspaceRoot = await createEvalWorkspace('echo-eval-demo-');
    workspaces.push(workspaceRoot);
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'src', 'status.txt'), 'STATUS=FAIL\n', 'utf8');
    await writeFile(
      path.join(workspaceRoot, 'src', 'notes.txt'),
      'locate the failing status\n',
      'utf8',
    );

    const run = await runOfflineEval({
      name: 'demo-loop',
      workspaceRoot,
      goal: 'Find STATUS=FAIL, fix it to PASS, write a report, and re-check the file.',
      responses: [
        toolTurn({ id: 'call-list', name: 'list_files', arguments: { path: 'src' } }),
        toolTurn({
          id: 'call-search',
          name: 'search_text',
          arguments: { query: 'FAIL', path: 'src' },
        }),
        toolTurn({ id: 'call-read', name: 'read_file', arguments: { path: 'src/status.txt' } }),
        toolTurn({
          id: 'call-write',
          name: 'write_file',
          arguments: { path: 'src/report.txt', content: 'checked\n' },
        }),
        toolTurn({
          id: 'call-patch',
          name: 'apply_patch',
          arguments: {
            path: 'src/status.txt',
            edits: [{ oldText: 'STATUS=FAIL', newText: 'STATUS=PASS' }],
          },
        }),
        toolTurn({
          id: 'call-command',
          name: 'run_command',
          arguments: { command: 'Get-Content -LiteralPath src/status.txt' },
        }),
        textTurn('STATUS is PASS and the report exists.'),
      ],
    });

    expect(run.summary).toBe(
      formatEvalSummary({
        name: 'demo-loop',
        status: 'completed',
        steps: 7,
        toolCalls: 6,
        stopReason: 'completed',
      }),
    );
    expect(run.record).toMatchObject({
      name: 'demo-loop',
      status: 'completed',
      steps: 7,
      toolCalls: 6,
      stopReason: 'completed',
    });
    expect(run.result.finalText).toContain('STATUS is PASS');
    expect(completedToolNames(run.events)).toEqual([...DEFAULT_EVAL_TOOLS]);
    expect(terminalToolEvents(run.events)).toHaveLength(6);
    expect(jsonlHasContextProjection(run.events)).toBe(true);
    expect(run.provider.requests).toHaveLength(7);
    expect(run.provider.requests[1]?.messages.some((message) => message.role === 'tool')).toBe(
      true,
    );

    const status = await readFile(path.join(workspaceRoot, 'src', 'status.txt'), 'utf8');
    const report = await readFile(path.join(workspaceRoot, 'src', 'report.txt'), 'utf8');
    expect(status).toContain('STATUS=PASS');
    expect(report).toBe('checked\n');

    const jsonl = await readFile(
      path.join(workspaceRoot, '.echo', 'sessions', `${run.result.sessionId}.jsonl`),
      'utf8',
    );
    expect(jsonl).not.toContain(os.homedir());
    expect(jsonl).not.toContain(workspaceRoot);
    expect(jsonl).toContain('"type":"context.projected"');
  });
});
