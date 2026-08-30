import { describe, expect, it } from 'vitest';

import type {
  AgentResult,
  EchoEvent,
  EchoEventPayloads,
  EchoEventType,
  EndpointFingerprint,
  RenderCapabilities,
} from '../../../src/contracts/index.js';
import {
  DefaultEventRenderer,
  extractTestEvidence,
  formatDuration,
} from '../../../src/cli/event-renderer.js';

const plain: RenderCapabilities = {
  interactive: false,
  color: false,
  unicode: false,
  verbose: false,
  columns: 80,
};

const unicode: RenderCapabilities = { ...plain, unicode: true };
const narrow: RenderCapabilities = { ...plain, columns: 28 };
const colorOn: RenderCapabilities = { ...plain, color: true };

function event<T extends EchoEventType>(type: T, payload: EchoEventPayloads[T]): EchoEvent {
  return {
    id: `event-${type}`,
    sequence: 1,
    timestamp: '2026-08-28T00:00:00.000Z',
    sessionId: 'session-test',
    turnId: 'turn-test',
    stepId: 'step-test',
    type,
    payload,
  } as EchoEvent;
}

const completed: AgentResult = {
  sessionId: 'session-test',
  turnId: 'turn-test',
  status: 'completed',
  stopReason: 'completed',
  finalText: 'final answer',
  steps: 2,
  toolCalls: 1,
};

function join(chunks: readonly { text: string }[]): string {
  return chunks.map((chunk) => chunk.text).join('');
}

function requestCommand(
  renderer: DefaultEventRenderer,
  id = 'call-1',
  command = 'pnpm test',
): void {
  renderer.renderEvent(
    event('tool.requested', {
      call: { id, name: 'run_command', arguments: { command } },
      normalizedInput: { command },
    }),
    plain,
  );
}

describe('DefaultEventRenderer', () => {
  it('routes progress to stderr and the final answer only to stdout', () => {
    const renderer = new DefaultEventRenderer();

    expect(join(renderer.renderEvent(event('turn.started', { goal: 'fix tests' }), plain))).toBe(
      'ECHO       | fix tests\n',
    );
    expect(join(renderer.renderEvent(event('step.started', { step: 1 }), plain))).toContain(
      '-- Step 1 ',
    );
    expect(
      join(renderer.renderEvent(event('step.started', { step: 1 }), plain)).startsWith('\n'),
    ).toBe(true);

    const result = renderer.renderResult(completed, plain);
    expect(result[0]).toEqual({ channel: 'stdout', text: 'final answer\n' });
    const stderr = join(result.slice(1));
    expect(stderr).toContain('-- Run completed ');
    expect(stderr).toContain('STEPS      | 2');
    expect(stderr).toContain('TOOLS      | 1');
    expect(stderr).toContain('CHANGES    | none');
    expect(stderr).toContain('NOT VERIFIED');
    expect(stderr).not.toContain('DONE');
  });

  it('keeps command success distinct from turn completion and reports verification evidence', () => {
    const renderer = new DefaultEventRenderer();
    expect(
      join(
        renderer.renderEvent(
          event('tool.requested', {
            call: { id: 'call-1', name: 'run_command', arguments: { command: 'pnpm test' } },
            normalizedInput: { command: 'pnpm test' },
          }),
          plain,
        ),
      ),
    ).toContain('TOOL       | run_command');
    expect(
      join(
        renderer.renderEvent(
          event('tool.completed', {
            result: {
              toolCallId: 'call-1',
              toolName: 'run_command',
              status: 'completed',
              summary: 'Command completed.',
              metadata: {
                exitCode: 0,
                durationMs: 2100,
                stdout: '# tests 12\n# pass 12\n# fail 0\n',
                stderr: '',
              },
            },
            durationMs: 2100,
          }),
          plain,
        ),
      ),
    ).toBe('RESULT     | OK | exit 0 | 2.1 s\n           | 12 tests passed\n');

    const summary = join(renderer.renderResult(completed, plain).slice(1));
    expect(summary).toContain('VERIFIED   | pnpm test | exit 0 | 2.1 s');
    expect(summary).not.toContain('LAST CHECK');
  });

  it('renders a failed test command as RESULT FAIL with exit code and test summary', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer);

    expect(
      join(
        renderer.renderEvent(
          event('tool.completed', {
            result: {
              toolCallId: 'call-1',
              toolName: 'run_command',
              status: 'completed',
              summary: 'Command exited with code 1 after 2400 ms.',
              metadata: {
                exitCode: 1,
                durationMs: 2400,
                stdout: '# tests 2\n# pass 1\n# fail 1\n',
                stderr: '',
              },
            },
            durationMs: 2400,
          }),
          plain,
        ),
      ),
    ).toBe('RESULT     | FAIL | exit 1 | 2.4 s\n           | 1 test failed\n');
  });

  it('renders apply_patch with a relative path, change counts, and a bounded diff', () => {
    const renderer = new DefaultEventRenderer();
    const requested = join(
      renderer.renderEvent(
        event('tool.requested', {
          call: {
            id: 'call-patch',
            name: 'apply_patch',
            arguments: { path: 'src/parse-report.ts', edits: [] },
          },
          normalizedInput: { path: 'src/parse-report.ts' },
        }),
        plain,
      ),
    );
    expect(requested).toContain('TOOL       | apply_patch');
    expect(requested).toContain('TARGET     | src/parse-report.ts');

    const rendered = join(
      renderer.renderEvent(
        event('tool.completed', {
          result: {
            toolCallId: 'call-patch',
            toolName: 'apply_patch',
            status: 'completed',
            summary: 'Applied 1 edits to src/parse-report.ts.',
            metadata: {
              path: 'src/parse-report.ts',
              additions: 1,
              deletions: 1,
              diff: '--- a/src/parse-report.ts\n+++ b/src/parse-report.ts\n-    total: passed,\n+    total: passed + failed,\n',
            },
          },
          durationMs: 12,
        }),
        plain,
      ),
    );

    expect(rendered).toContain('RESULT     | OK | 1 file changed | +1 -1');
    expect(rendered).toContain('--- a/src/parse-report.ts');
    expect(rendered).toContain('+    total: passed + failed,');
    expect(join(renderer.renderResult(completed, plain).slice(1))).toContain('CHANGES    | 1 file');
  });

  it('buffers assistant progress on stderr only when the Step requested tools', () => {
    const renderer = new DefaultEventRenderer();
    renderer.renderEvent(event('step.started', { step: 1 }), plain);
    expect(
      renderer.renderEvent(
        event('model.text_delta', { delta: 'I will inspect the parser.' }),
        plain,
      ),
    ).toEqual([]);
    renderer.renderEvent(
      event('model.tool_call', {
        call: { id: 'call-1', name: 'search_text', arguments: { query: 'parseReport' } },
      }),
      plain,
    );
    expect(
      join(renderer.renderEvent(event('model.completed', { finishReason: 'tool_calls' }), plain)),
    ).toBe('ECHO       | I will inspect the parser.\n');
  });

  it('buffers aggregated model.text the same way as concatenated text deltas', () => {
    const renderer = new DefaultEventRenderer();
    renderer.renderEvent(event('step.started', { step: 1 }), plain);
    expect(
      renderer.renderEvent(event('model.text', { text: 'I will inspect the parser.' }), plain),
    ).toEqual([]);
    renderer.renderEvent(
      event('model.tool_call', {
        call: { id: 'call-1', name: 'search_text', arguments: { query: 'parseReport' } },
      }),
      plain,
    );
    expect(
      join(renderer.renderEvent(event('model.completed', { finishReason: 'tool_calls' }), plain)),
    ).toBe('ECHO       | I will inspect the parser.\n');
  });

  it('does not concatenate mixed aggregated text and text deltas in one step', () => {
    const renderer = new DefaultEventRenderer();
    renderer.renderEvent(event('step.started', { step: 1 }), plain);
    renderer.renderEvent(event('model.text', { text: 'aggregated' }), plain);
    renderer.renderEvent(event('model.text_delta', { delta: 'delta' }), plain);
    renderer.renderEvent(
      event('model.tool_call', {
        call: { id: 'call-1', name: 'search_text', arguments: { query: 'x' } },
      }),
      plain,
    );
    expect(
      join(renderer.renderEvent(event('model.completed', { finishReason: 'tool_calls' }), plain)),
    ).toBe('ECHO       | aggregated\n');
  });

  it('inserts one blank line between complete groups, not inside a tool group', () => {
    const renderer = new DefaultEventRenderer();
    renderer.renderEvent(event('step.started', { step: 2 }), plain);
    renderer.renderEvent(event('model.text_delta', { delta: 'Checking the script.' }), plain);
    renderer.renderEvent(
      event('model.tool_call', {
        call: { id: 'call-1', name: 'run_command', arguments: { command: 'python test.py' } },
      }),
      plain,
    );
    expect(
      join(renderer.renderEvent(event('model.completed', { finishReason: 'tool_calls' }), plain)),
    ).toBe('ECHO       | Checking the script.\n');

    const firstTool = join(
      renderer.renderEvent(
        event('tool.requested', {
          call: { id: 'call-1', name: 'run_command', arguments: { command: 'python test.py' } },
          normalizedInput: { command: 'python test.py' },
        }),
        plain,
      ),
    );
    expect(firstTool.startsWith('\n')).toBe(true);
    expect(firstTool).toBe('\nTOOL       | run_command\nCOMMAND    | python test.py\n');

    const approval = join(
      renderer.renderEvent(
        event('approval.requested', {
          toolCallId: 'call-1',
          reason: 'unclassified script',
          approvalKey: 'approval:test',
        }),
        plain,
      ),
    );
    expect(approval.startsWith('\n')).toBe(false);
    expect(approval).toContain('APPROVAL   | Required');

    const approved = join(
      renderer.renderEvent(
        event('approval.granted', {
          toolCallId: 'call-1',
          approvalKey: 'approval:test',
          scope: 'once',
        }),
        plain,
      ),
    );
    expect(approved).toBe('APPROVED   | once\n');

    const result = join(
      renderer.renderEvent(
        event('tool.completed', {
          result: {
            toolCallId: 'call-1',
            toolName: 'run_command',
            status: 'completed',
            summary: 'Command completed.',
            metadata: { exitCode: 0, durationMs: 268, stdout: '', stderr: '' },
          },
          durationMs: 268,
        }),
        plain,
      ),
    );
    expect(result.startsWith('\n')).toBe(false);
    expect(result).toContain('RESULT     | OK | exit 0 | 268 ms');

    const secondTool = join(
      renderer.renderEvent(
        event('tool.requested', {
          call: { id: 'call-2', name: 'run_command', arguments: { command: 'python test.py 2' } },
          normalizedInput: { command: 'python test.py 2' },
        }),
        plain,
      ),
    );
    expect(secondTool.startsWith('\n')).toBe(true);
    expect(secondTool).toContain('TOOL       | run_command');
  });

  it('renders a user denial once when approval.denied is followed by tool.denied', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer, 'call-deny', 'python test.py');
    const approvalDenied = join(
      renderer.renderEvent(
        event('approval.denied', {
          toolCallId: 'call-deny',
          reason: 'The user denied this operation.',
        }),
        plain,
      ),
    );
    const toolDenied = join(
      renderer.renderEvent(
        event('tool.denied', {
          result: {
            toolCallId: 'call-deny',
            toolName: 'run_command',
            status: 'denied',
            summary: 'The user denied this operation.',
          },
          hard: false,
        }),
        plain,
      ),
    );
    expect(approvalDenied).toBe('DENIED     | The user denied this operation.\n');
    expect(toolDenied).toBe('');
    expect(`${approvalDenied}${toolDenied}`.match(/DENIED\s+\|/gu)).toHaveLength(1);

    const failed = join(
      renderer
        .renderResult(
          {
            sessionId: completed.sessionId,
            turnId: completed.turnId,
            status: 'failed',
            stopReason: 'policy_denied',
            steps: 1,
            toolCalls: 1,
            error: {
              category: 'policy_denied',
              code: 'policy_denied',
              message: 'The user denied this operation.',
              retryable: false,
            },
          },
          plain,
        )
        .slice(1),
    );
    expect(failed).toContain('One or more operations were denied.');
    expect(failed).toContain('The user denied this operation.');
    expect(failed).not.toContain('policy_denied | The user denied this operation.');
  });

  it('ignores model.reasoning and does not render a blank ECHO for empty failures', () => {
    const renderer = new DefaultEventRenderer({}, 'chat');
    expect(
      renderer.renderEvent(event('model.reasoning', { reasoning: 'secret chain' }), {
        ...plain,
        verbose: true,
      }),
    ).toEqual([]);
    const emptyFailed = join(
      renderer.renderResult(
        {
          sessionId: 'session-test',
          turnId: 'turn-test',
          status: 'failed',
          stopReason: 'provider_error',
          finalText: '',
          steps: 1,
          toolCalls: 0,
          error: {
            category: 'provider_protocol',
            code: 'PROVIDER_REASONING_BUDGET_EXHAUSTED',
            message:
              'The model exhausted its output budget before producing a visible response or tool call.',
            retryable: false,
          },
        },
        plain,
      ),
    );
    expect(emptyFailed).toContain('Turn failed');
    expect(emptyFailed).toContain('provider_error');
    expect(emptyFailed).toContain('exhausted its output budget');
    expect(emptyFailed).not.toContain('ECHO       |');
    expect(emptyFailed).not.toContain('secret chain');

    const limited = join(
      renderer.renderResult(
        {
          sessionId: 'session-test',
          turnId: 'turn-test',
          status: 'limited',
          stopReason: 'output_limit',
          finalText: 'partial body',
          steps: 1,
          toolCalls: 0,
          error: {
            category: 'provider_protocol',
            code: 'PROVIDER_OUTPUT_LIMIT',
            message: 'The response may be incomplete.',
            retryable: false,
          },
        },
        plain,
      ),
    );
    expect(limited).toContain('ECHO       | partial body');
    expect(limited).toContain('Turn limited');
    expect(limited).toContain('output_limit');
    expect(limited).toContain('NOT VERIFIED');
  });

  it('does not print intermediate text or reasoning-only progress on the final-text path', () => {
    const renderer = new DefaultEventRenderer();
    renderer.renderEvent(event('step.started', { step: 2 }), plain);
    renderer.renderEvent(event('model.text_delta', { delta: 'reasoning' }), plain);
    expect(renderer.renderEvent(event('model.completed', { finishReason: 'stop' }), plain)).toEqual(
      [],
    );
    expect(renderer.renderResult(completed, plain)[0]).toEqual({
      channel: 'stdout',
      text: 'final answer\n',
    });
  });

  it('renders read, search, and list results as structured summaries without file bodies', () => {
    const renderer = new DefaultEventRenderer();
    expect(
      join(
        renderer.renderEvent(
          event('tool.completed', {
            result: {
              toolCallId: 'call-read',
              toolName: 'read_file',
              status: 'completed',
              summary: 'Read lines 1-24 from src/parse-report.ts.',
              metadata: { path: 'src/parse-report.ts', totalLines: 24, content: 'secret body' },
            },
            durationMs: 4,
          }),
          plain,
        ),
      ),
    ).toBe('RESULT     | OK | 24 lines read\n');
    expect(
      join(
        renderer.renderEvent(
          event('tool.completed', {
            result: {
              toolCallId: 'call-search',
              toolName: 'search_text',
              status: 'completed',
              summary: 'Found 3 text matches.',
              metadata: { totalMatches: 3, omittedMatches: 0 },
            },
            durationMs: 8,
          }),
          plain,
        ),
      ),
    ).toBe('RESULT     | 3 matches\n');
  });

  it('renders failures, denials, limits, cancellation, and verbose diagnostics explicitly', () => {
    const renderer = new DefaultEventRenderer();
    const verbose = { ...plain, verbose: true };

    expect(
      join(
        renderer.renderEvent(
          event('tool.denied', {
            result: {
              toolCallId: 'call-1',
              toolName: 'run_command',
              status: 'denied',
              summary: 'network denied',
            },
            hard: true,
          }),
          plain,
        ),
      ),
    ).toContain('DENIED     | Hard policy');
    expect(
      join(renderer.renderEvent(event('limit.reached', { kind: 'max_steps', limit: 4 }), plain)),
    ).toContain('LIMIT      | max_steps | limit 4');
    expect(
      join(
        renderer.renderEvent(
          event('tool.cancelled', {
            result: {
              toolCallId: 'call-1',
              toolName: 'run_command',
              status: 'cancelled',
              summary: 'cancelled',
            },
            phase: 'execution',
          }),
          plain,
        ),
      ),
    ).toContain('CANCELLED  | execution | cancelled');
    expect(
      join(
        renderer.renderEvent(
          event('context.projected', {
            approximateTokens: 100,
            omittedEventCount: 2,
            truncationCount: 1,
          }),
          verbose,
        ),
      ),
    ).toContain('100 approx tokens');
    const limited = join(
      renderer
        .renderResult({ ...completed, status: 'limited', stopReason: 'max_steps' }, plain)
        .slice(1),
    );
    expect(limited).toContain('-- Run limited ');
    expect(limited).toContain('REASON     | max_steps');
    expect(limited).toContain('A step, repetition, or budget limit was reached.');
  });

  it('renders approval with hanging risk, scope, and choice keys', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer, 'call-install', 'pnpm install');
    const text = join(
      renderer.renderEvent(
        event('approval.requested', {
          toolCallId: 'call-install',
          reason: 'dependency and lockfile changes',
          approvalKey: 'approval:test',
        }),
        plain,
      ),
    );
    expect(text).toContain('APPROVAL   | Required');
    expect(text).toContain('Risk   dependency and lockfile changes');
    expect(text).toContain('Scope  once or equivalent operations in this session');
    expect(text).toContain('Approve [y] once / [s] session / [n] deny');
    expect(text).not.toContain('requires confirmation');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('keeps the interactive approval prompt open so the answer stays on the same line', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer, 'call-install', 'pnpm install');
    const chunks = renderer.renderEvent(
      event('approval.requested', {
        toolCallId: 'call-install',
        reason: 'dependency and lockfile changes',
        approvalKey: 'approval:test',
      }),
      { ...plain, interactive: true },
    );
    expect(join(chunks).endsWith('\n')).toBe(false);
    expect(join(chunks)).toContain('Approve [y] once / [s] session / [n] deny > ');
  });

  it('uses LAST CHECK instead of VERIFIED when the Turn failed', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer);
    renderer.renderEvent(
      event('tool.completed', {
        result: {
          toolCallId: 'call-1',
          toolName: 'run_command',
          status: 'completed',
          summary: 'Command completed.',
          metadata: { exitCode: 0, durationMs: 1000, stdout: '# pass 1\n# fail 0\n', stderr: '' },
        },
        durationMs: 1000,
      }),
      plain,
    );
    const failed: AgentResult = {
      sessionId: completed.sessionId,
      turnId: completed.turnId,
      status: 'failed',
      stopReason: 'policy_denied',
      steps: completed.steps,
      toolCalls: completed.toolCalls,
    };
    const text = join(renderer.renderResult(failed, plain));
    expect(text).toContain('-- Run failed ');
    expect(text).toContain('REASON     | policy_denied');
    expect(text).toContain('LAST CHECK | pnpm test | exit 0 | 1.0 s');
    expect(text).not.toContain('VERIFIED');
    expect(text).not.toContain('stdout');
  });

  it('uses ANSI only on labels or status words and defensively redacts personal paths and secrets', () => {
    const renderer = new DefaultEventRenderer({
      homeDirectory: 'C:\\Users\\private-name',
      secrets: ['sk-secret-demo-key'],
    });
    const unsafe = event('turn.started', {
      goal: 'read C:\\Users\\private-name\\secret.txt with sk-secret-demo-key',
    });

    expect(join(renderer.renderEvent(unsafe, plain))).toBe(
      'ECHO       | read <home>\\secret.txt with [REDACTED]\n',
    );
    const colored = join(renderer.renderEvent(unsafe, colorOn));
    expect(colored).toContain('\u001B[');
    expect(colored).toContain('read <home>\\secret.txt with [REDACTED]');
    expect(join(renderer.renderEvent(unsafe, plain))).not.toContain('\u001B[');
    expect(join(renderer.renderEvent(unsafe, plain))).not.toContain('private-name');
    expect(join(renderer.renderEvent(unsafe, plain))).not.toContain('sk-secret-demo-key');
  });

  it('shows command stderr when a non-zero exit has no test summary', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer, 'call-build', 'pnpm build');
    const text = join(
      renderer.renderEvent(
        event('tool.completed', {
          result: {
            toolCallId: 'call-build',
            toolName: 'run_command',
            status: 'completed',
            summary: 'Command exited with code 1 after 400 ms.',
            metadata: {
              exitCode: 1,
              durationMs: 400,
              stdout: '',
              stderr: 'error TS2304: Cannot find name Demo',
              stdoutTruncated: false,
              stderrTruncated: true,
              stdoutOriginalChars: 0,
              stderrOriginalChars: 4000,
            },
            truncated: true,
          },
          durationMs: 400,
        }),
        plain,
      ),
    );
    expect(text).toContain('RESULT     | FAIL | exit 1 | 400 ms');
    expect(text).toContain('stderr: error TS2304: Cannot find name Demo');
    expect(text).toContain('output truncated: yes');
  });

  it('marks a truncated apply_patch diff without treating the tool as the Turn result', () => {
    const renderer = new DefaultEventRenderer();
    const text = join(
      renderer.renderEvent(
        event('tool.completed', {
          result: {
            toolCallId: 'call-patch',
            toolName: 'apply_patch',
            status: 'completed',
            summary: 'Applied 1 edits.',
            metadata: {
              path: 'src/parse-report.ts',
              additions: 1,
              deletions: 1,
              omittedDiffChars: 80,
              diff: '--- a/src/parse-report.ts\n+++ b/src/parse-report.ts\n',
            },
            truncated: true,
          },
          durationMs: 9,
        }),
        plain,
      ),
    );
    expect(text).toContain('RESULT     | OK | 1 file changed | +1 -1');
    expect(text).toContain('diff truncated');
    expect(text).not.toContain('Run completed');
  });

  it('wraps CJK command text on the body column and stacks on a narrow terminal', () => {
    const renderer = new DefaultEventRenderer();
    const longCommand = '检查当前测试失败并修复问题，然后继续运行完整质量门以确保没有回归。';
    const wrapped = join(
      renderer.renderEvent(
        event('tool.requested', {
          call: { id: 'call-cjk', name: 'run_command', arguments: { command: longCommand } },
          normalizedInput: { command: longCommand },
        }),
        { ...plain, columns: 42 },
      ),
    );
    expect(wrapped).toContain('COMMAND    |');
    expect(wrapped).toMatch(/ {11}\| /u);

    const stacked = join(
      renderer.renderEvent(
        event('tool.requested', {
          call: { id: 'call-narrow', name: 'run_command', arguments: { command: longCommand } },
          normalizedInput: { command: longCommand },
        }),
        narrow,
      ),
    );
    expect(stacked).toContain('TOOL\n');
    expect(stacked).toContain('run_command');
    expect(stacked).toContain('COMMAND\n');
    expect(stacked).not.toContain('TOOL       |');
  });

  it('uses Unicode separators when enabled and ASCII otherwise', () => {
    const renderer = new DefaultEventRenderer();
    expect(join(renderer.renderEvent(event('turn.started', { goal: 'fix tests' }), unicode))).toBe(
      'ECHO       │ fix tests\n',
    );
    const chatRenderer = new DefaultEventRenderer({}, 'chat');
    expect(chatRenderer.renderEvent(event('turn.started', { goal: 'fix tests' }), unicode)).toEqual(
      [],
    );
    expect(join(renderer.renderEvent(event('step.started', { step: 6 }), unicode))).toContain(
      '── Step 6 ',
    );
  });

  it('labels Chat final replies on stderr and titles the summary as a Turn', () => {
    const renderer = new DefaultEventRenderer({}, 'chat');
    const result = renderer.renderResult(completed, plain);
    expect(result.some((chunk) => chunk.channel === 'stdout')).toBe(false);
    const text = join(result);
    expect(text).toContain('ECHO       | final answer');
    expect(text).toContain('-- Turn completed ');
    expect(text).not.toContain('-- Run completed ');
  });

  it('keeps Chat replies on stderr and does not let CR rewind the ECHO line', () => {
    const renderer = new DefaultEventRenderer({}, 'chat');
    const result = renderer.renderResult(
      {
        ...completed,
        finalText: 'line one\r\nline two\r',
      },
      plain,
    );
    const text = join(result);
    expect(result.some((chunk) => chunk.channel === 'stdout')).toBe(false);
    expect(text).toContain('ECHO       | line one');
    expect(text).toContain('line two');
    expect(text).not.toContain('\r');
  });
});

describe('render helpers', () => {
  it('formats durations and extracts node:test summaries', () => {
    expect(formatDuration(25)).toBe('25 ms');
    expect(formatDuration(2400)).toBe('2.4 s');
    expect(extractTestEvidence('# tests 2\n# pass 1\n# fail 1\n', '')).toBe('1 test failed');
    expect(extractTestEvidence('# tests 12\n# pass 12\n# fail 0\n', '')).toBe('12 tests passed');
    expect(extractTestEvidence('ℹ pass 2\nℹ fail 0\n', '')).toBe('2 tests passed');
  });

  it('does not change run output for frozen P1 session events', () => {
    const renderer = new DefaultEventRenderer();
    expect(
      renderer.renderEvent(
        event('session.resumed', {
          eventSchemaVersion: 2,
          provider: {
            kind: 'openai-compatible',
            name: 'openai-compatible',
            endpointFingerprint: 'fp:example.test' as EndpointFingerprint,
          },
          model: 'example-model',
          safetyMode: 'balanced',
          turnCount: 3,
        }),
        plain,
      ),
    ).toEqual([]);
    expect(
      renderer.renderEvent(
        event('model.changed', {
          model: 'next-model',
          previousModel: 'example-model',
          source: 'slash',
        }),
        plain,
      ),
    ).toEqual([]);
    expect(
      renderer.renderEvent(
        event('safety.changed', {
          safetyMode: 'auto',
          previousSafetyMode: 'balanced',
          source: 'slash',
        }),
        plain,
      ),
    ).toEqual([]);
  });
});
