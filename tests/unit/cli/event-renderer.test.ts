import { describe, expect, it } from 'vitest';

import type {
  AgentResult,
  EchoEvent,
  EchoEventPayloads,
  EchoEventType,
  RenderCapabilities,
} from '../../../src/contracts/index.js';
import { DefaultEventRenderer } from '../../../src/cli/event-renderer.js';

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

  it('keeps tool success distinct from turn completion and reports verification evidence', () => {
    const renderer = new DefaultEventRenderer();
    renderer.renderEvent(
      event('tool.requested', {
        call: { id: 'call-1', name: 'run_command', arguments: { command: 'pnpm test' } },
        normalizedInput: { command: 'pnpm test' },
      }),
      plain,
    );

    expect(
      renderer.renderEvent(
        event('tool.completed', {
          result: {
            toolCallId: 'call-1',
            toolName: 'run_command',
            status: 'completed',
            summary: 'Command completed.',
            metadata: { exitCode: 0, durationMs: 25 },
          },
          durationMs: 25,
        }),
        plain,
      ),
    ).toEqual([{ channel: 'stderr', text: 'OK     Command completed.\n' }]);

    expect(renderer.renderResult(completed, plain)[1]?.text).toContain(
      'Verification: pnpm test · exit 0',
    );
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
  });

  it('uses ANSI only when color is enabled and defensively redacts personal paths', () => {
    const renderer = new DefaultEventRenderer({ homeDirectory: 'C:\\Users\\private-name' });
    const unsafe = event('turn.started', { goal: 'read C:\\Users\\private-name\\secret.txt' });

    expect(renderer.renderEvent(unsafe, plain)[0]?.text).toBe('ECHO   read <home>\\secret.txt\n');
    expect(renderer.renderEvent(unsafe, { ...plain, color: true })[0]?.text).toContain('\u001B[');
    expect(renderer.renderEvent(unsafe, plain)[0]?.text).not.toContain('\u001B[');
  });
});
