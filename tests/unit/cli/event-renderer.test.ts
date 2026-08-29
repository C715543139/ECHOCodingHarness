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
};

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

    expect(renderer.renderEvent(event('turn.started', { goal: 'fix tests' }), plain)).toEqual([
      { channel: 'stderr', text: 'ECHO   fix tests\n' },
    ]);
    expect(renderer.renderEvent(event('step.started', { step: 1 }), plain)).toEqual([
      { channel: 'stderr', text: 'STEP   1\n' },
    ]);
    expect(renderer.renderResult(completed, plain)).toEqual([
      { channel: 'stdout', text: 'final answer\n' },
      {
        channel: 'stderr',
        text: 'DONE   completed\n  2 steps · 1 tool call · no file changes\n',
      },
    ]);
  });

  it('keeps command success distinct from turn completion and reports verification evidence', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer);

    expect(
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
    ).toEqual([
      { channel: 'stderr', text: 'OK     exit 0 · 2.1s\n' },
      { channel: 'stderr', text: '  12 tests passed\n' },
    ]);

    expect(renderer.renderResult(completed, plain)[1]?.text).toContain(
      'Verification: pnpm test · exit 0',
    );
  });

  it('renders a failed test command as FAIL with exit code and test summary', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer);

    expect(
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
    ).toEqual([
      { channel: 'stderr', text: 'FAIL   exit 1 · 2.4s\n' },
      { channel: 'stderr', text: '  1 test failed\n' },
    ]);
  });

  it('renders apply_patch with a relative path, change counts, and a bounded diff', () => {
    const renderer = new DefaultEventRenderer();
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
    );

    const rendered = renderer.renderEvent(
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
    );

    expect(rendered[0]?.text).toBe('OK     src/parse-report.ts · +1 -1\n');
    expect(rendered.map((chunk) => chunk.text).join('')).toContain('--- a/src/parse-report.ts');
    expect(rendered.map((chunk) => chunk.text).join('')).toContain('+    total: passed + failed,');
    expect(renderer.renderResult(completed, plain)[1]?.text).toContain('1 file changed');
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
      renderer.renderEvent(event('model.completed', { finishReason: 'tool_calls' }), plain),
    ).toEqual([{ channel: 'stderr', text: 'ECHO   I will inspect the parser.\n' }]);
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
      )[0]?.text,
    ).toBe('OK     24 lines read\n');
    expect(
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
      )[0]?.text,
    ).toBe('OK     3 matches\n');
  });

  it('renders failures, denials, limits, cancellation, and verbose diagnostics explicitly', () => {
    const renderer = new DefaultEventRenderer();
    const verbose = { ...plain, verbose: true };

    expect(
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
      )[0]?.text,
    ).toContain('DENIED');
    expect(
      renderer.renderEvent(event('limit.reached', { kind: 'max_steps', limit: 4 }), plain)[0]?.text,
    ).toContain('LIMIT');
    expect(
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
      )[0]?.text,
    ).toContain('CANCELLED');
    expect(
      renderer.renderEvent(
        event('context.projected', {
          approximateTokens: 100,
          omittedEventCount: 2,
          truncationCount: 1,
        }),
        verbose,
      )[0]?.text,
    ).toContain('100 approx tokens');
    expect(
      renderer
        .renderResult({ ...completed, status: 'limited', stopReason: 'max_steps' }, plain)
        .at(-1)?.text,
    ).toContain('a step, repetition, or budget limit was reached');
  });

  it('renders approval with command summary, risk, and session scope options', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer, 'call-install', 'pnpm install');
    const text = renderer
      .renderEvent(
        event('approval.requested', {
          toolCallId: 'call-install',
          reason: 'dependency and lockfile changes',
          approvalKey: 'approval:test',
        }),
        plain,
      )
      .map((chunk) => chunk.text)
      .join('');
    expect(text).toContain('APPROVAL');
    expect(text).toContain('run_command requires confirmation');
    expect(text).toContain('Command: pnpm install');
    expect(text).toContain('Risk: dependency and lockfile changes');
    expect(text).toContain('this operation / equivalent operations in this session');
  });

  it('uses ANSI only when color is enabled and defensively redacts personal paths and secrets', () => {
    const renderer = new DefaultEventRenderer({
      homeDirectory: 'C:\\Users\\private-name',
      secrets: ['sk-secret-demo-key'],
    });
    const unsafe = event('turn.started', {
      goal: 'read C:\\Users\\private-name\\secret.txt with sk-secret-demo-key',
    });

    expect(renderer.renderEvent(unsafe, plain)[0]?.text).toBe(
      'ECHO   read <home>\\secret.txt with [REDACTED]\n',
    );
    expect(renderer.renderEvent(unsafe, { ...plain, color: true })[0]?.text).toContain('\u001B[');
    expect(renderer.renderEvent(unsafe, plain)[0]?.text).not.toContain('\u001B[');
    expect(renderer.renderEvent(unsafe, plain)[0]?.text).not.toContain('private-name');
    expect(renderer.renderEvent(unsafe, plain)[0]?.text).not.toContain('sk-secret-demo-key');
  });

  it('shows command stderr when a non-zero exit has no test summary', () => {
    const renderer = new DefaultEventRenderer();
    requestCommand(renderer, 'call-build', 'pnpm build');
    const rendered = renderer.renderEvent(
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
    );
    const text = rendered.map((chunk) => chunk.text).join('');
    expect(text).toContain('FAIL   exit 1 · 400ms');
    expect(text).toContain('stderr: error TS2304: Cannot find name Demo');
    expect(text).toContain('output truncated: yes');
  });

  it('marks a truncated apply_patch diff without treating the tool as the Turn result', () => {
    const renderer = new DefaultEventRenderer();
    const rendered = renderer.renderEvent(
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
    );
    const text = rendered.map((chunk) => chunk.text).join('');
    expect(text).toContain('OK     src/parse-report.ts · +1 -1');
    expect(text).toContain('diff truncated');
    expect(text).not.toContain('DONE');
  });
});

describe('render helpers', () => {
  it('formats durations and extracts node:test summaries', () => {
    expect(formatDuration(25)).toBe('25ms');
    expect(formatDuration(2400)).toBe('2.4s');
    expect(extractTestEvidence('# tests 2\n# pass 1\n# fail 1\n', '')).toBe('1 test failed');
    expect(extractTestEvidence('# tests 12\n# pass 12\n# fail 0\n', '')).toBe('12 tests passed');
    expect(extractTestEvidence('ℹ pass 2\nℹ fail 0\n', '')).toBe('2 tests passed');
  });

  it('does not change P0 output for frozen P1 session events', () => {
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
