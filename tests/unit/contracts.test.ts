import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  isToolTerminalEvent,
  type EchoError,
  type EchoEvent,
  type EchoEventOf,
  type ModelProvider,
  type PolicyDecision,
  type SafetyPolicy,
  type ToolDefinition,
  type ToolExecution,
  type ToolResultMessage,
} from '../../src/contracts/index.js';

const error: EchoError = {
  category: 'tool_execution',
  code: 'TOOL_FAILED',
  message: 'The tool failed.',
  retryable: false,
};

function createEvent<TType extends EchoEvent['type']>(
  type: TType,
  payload: EchoEventOf<TType>['payload'],
): EchoEventOf<TType> {
  return {
    id: 'event-1',
    sequence: 1,
    timestamp: '2026-08-27T00:00:00.000Z',
    sessionId: 'session-1',
    type,
    payload,
  };
}

describe('shared contracts', () => {
  it('preserves discriminated provider, policy, and tool results', () => {
    const modelEvent = { type: 'completed', finishReason: 'tool_calls' } as const;
    const policyDecision = {
      action: 'deny',
      reason: 'outside workspace',
      hard: true,
    } satisfies PolicyDecision;
    const toolExecution = {
      status: 'failed',
      summary: 'command failed',
      error,
      truncated: false,
    } satisfies ToolExecution<never>;

    expect(modelEvent.finishReason).toBe('tool_calls');
    expect(policyDecision.hard).toBe(true);
    expect(toolExecution.error.category).toBe('tool_execution');
  });

  it('recognizes every terminal tool event without treating a start as terminal', () => {
    const result = {
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'completed',
      summary: 'read complete',
    } as const;
    const completed = createEvent('tool.completed', { result, durationMs: 4 });
    const failed = createEvent('tool.failed', {
      result: { ...result, status: 'failed' },
      durationMs: 5,
    });
    const denied = createEvent('tool.denied', {
      result: { ...result, status: 'denied' },
      hard: true,
    });
    const cancelled = createEvent('tool.cancelled', {
      result: { ...result, status: 'cancelled' },
      phase: 'execution',
    });
    const started = createEvent('tool.started', {
      toolCallId: 'call-1',
      toolName: 'read_file',
    });

    expect([completed, failed, denied, cancelled].every(isToolTerminalEvent)).toBe(true);
    expect(isToolTerminalEvent(started)).toBe(false);
  });

  it('keeps module boundaries structural and implementation-independent', () => {
    expectTypeOf<ModelProvider['stream']>().toBeFunction();
    expectTypeOf<SafetyPolicy['evaluate']>().returns.resolves.toMatchTypeOf<PolicyDecision>();
    expectTypeOf<ToolDefinition<unknown>['execute']>().returns.resolves.toMatchTypeOf<
      ToolExecution<unknown>
    >();
    expectTypeOf<ToolResultMessage<'completed'>['status']>().toEqualTypeOf<'completed'>();
  });
});
