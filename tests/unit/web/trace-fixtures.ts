import type { EchoEvent, EchoEventOf, ToolResultMessage } from '../../../src/contracts/index.js';
import { EVENT_SCHEMA_VERSION } from '../../../src/contracts/index.js';
import { createProviderIdentity } from '../../../src/session/index.js';

const provider = createProviderIdentity('https://provider.example/v1');

let sequence = 0;

export function resetTraceFixtureSequence(): void {
  sequence = 0;
}

export function traceEvent<TType extends EchoEvent['type']>(
  type: TType,
  payload: EchoEventOf<TType>['payload'],
  extra: Partial<Pick<EchoEvent, 'id' | 'sequence' | 'turnId' | 'stepId' | 'timestamp'>> = {},
): EchoEventOf<TType> {
  sequence += 1;
  const clock = new Date(Date.parse('2026-08-30T09:00:00.000Z') + sequence * 1000).toISOString();
  return {
    id: extra.id ?? `event-${String(sequence)}`,
    sequence: extra.sequence ?? sequence,
    timestamp: extra.timestamp ?? clock,
    sessionId: 'session-trace',
    turnId: extra.turnId ?? 'turn-1',
    stepId: extra.stepId ?? 'step-1',
    type,
    payload,
  };
}

export function startedEvent(): EchoEvent {
  return {
    id: 'event-started',
    sequence: 0,
    timestamp: '2026-08-30T09:00:00.000Z',
    sessionId: 'session-trace',
    type: 'session.started',
    payload: {
      workspace: '.',
      safetyMode: 'balanced',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      provider,
      model: 'echo-model',
    },
  };
}

export function toolResult<TStatus extends 'completed' | 'failed' | 'denied' | 'cancelled'>(
  status: TStatus,
  overrides: Partial<ToolResultMessage<TStatus>> = {},
): ToolResultMessage<TStatus> {
  return {
    toolCallId: 'call-read',
    toolName: 'read_file',
    status,
    summary: 'ok',
    truncated: false,
    ...overrides,
  };
}

export function eightTypeEvents(): EchoEvent[] {
  resetTraceFixtureSequence();
  return [
    startedEvent(),
    traceEvent('turn.started', { goal: '列出工作区文件' }),
    traceEvent('step.started', { step: 1 }),
    traceEvent('context.projected', {
      approximateTokens: 1200,
      omittedEventCount: 2,
      truncationCount: 1,
      projectionVersion: 'ctx-v3',
      maxApproxTokens: 256_000,
      reservedOutputTokens: 4096,
      truncationReasons: ['old_tool_output'],
    }),
    traceEvent('model.started', { provider: 'openai-compatible', model: 'echo-model' }),
    traceEvent('model.reasoning', { reasoning: 'SECRET_REASONING_SHOULD_NOT_LEAK' }),
    traceEvent('model.text', { text: 'I will inspect the workspace.' }),
    traceEvent('model.completed', { finishReason: 'tool_calls' }),
    traceEvent('model.tool_call', {
      call: { id: 'call-write', name: 'write_file', arguments: { path: 'src/a.ts', content: 'x' } },
    }),
    traceEvent('tool.requested', {
      call: { id: 'call-write', name: 'write_file', arguments: { path: 'src/a.ts' } },
      normalizedInput: { path: 'src/a.ts', content: 'export const x = 1;\n' },
    }),
    traceEvent('approval.requested', {
      toolCallId: 'call-write',
      reason: 'Workspace write needs confirmation.',
      approvalKey: 'write:src/a.ts',
      policyRuleId: 'policy.tool.write_workspace',
    }),
    traceEvent('approval.granted', {
      toolCallId: 'call-write',
      approvalKey: 'write:src/a.ts',
      scope: 'once',
    }),
    traceEvent('tool.authorized', {
      toolCallId: 'call-write',
      source: 'approval',
      policyRuleId: 'policy.tool.write_workspace',
      reason: 'User allowed this write once.',
    }),
    traceEvent('tool.started', { toolCallId: 'call-write', toolName: 'write_file' }),
    traceEvent('tool.completed', {
      durationMs: 12,
      result: toolResult('completed', {
        toolCallId: 'call-write',
        toolName: 'write_file',
        summary: 'Updated src/a.ts',
        metadata: {
          path: 'src/a.ts',
          diff: '--- src/a.ts\n+++ src/a.ts\n+export const x = 1;\n',
          additions: 1,
          deletions: 0,
          omittedDiffChars: 0,
        },
      }),
    }),
    traceEvent('step.started', { step: 2 }, { stepId: 'step-2' }),
    traceEvent(
      'model.started',
      { provider: 'openai-compatible', model: 'echo-model' },
      { stepId: 'step-2' },
    ),
    traceEvent(
      'tool.requested',
      {
        call: { id: 'call-verify', name: 'run_command', arguments: { command: 'pnpm test' } },
        normalizedInput: { command: 'pnpm test' },
      },
      { stepId: 'step-2' },
    ),
    traceEvent(
      'tool.authorized',
      {
        toolCallId: 'call-verify',
        source: 'policy',
        policyRuleId: 'policy.command.test',
        reason: 'Read-only test command.',
      },
      { stepId: 'step-2' },
    ),
    traceEvent(
      'tool.started',
      { toolCallId: 'call-verify', toolName: 'run_command' },
      { stepId: 'step-2' },
    ),
    traceEvent(
      'tool.completed',
      {
        durationMs: 80,
        result: toolResult('completed', {
          toolCallId: 'call-verify',
          toolName: 'run_command',
          summary: 'Command completed in 80 ms.',
          metadata: {
            exitCode: 0,
            durationMs: 80,
            stdout: 'ok',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        }),
      },
      { stepId: 'step-2' },
    ),
    traceEvent('turn.completed', {
      result: {
        sessionId: 'session-trace',
        turnId: 'turn-1',
        status: 'completed',
        stopReason: 'completed',
        steps: 2,
        toolCalls: 2,
        finalText: 'Done.',
      },
    }),
  ];
}

export function legacyPolicyEvents(): EchoEvent[] {
  resetTraceFixtureSequence();
  return [
    startedEvent(),
    traceEvent('turn.started', { goal: 'legacy tool' }),
    traceEvent('step.started', { step: 1 }),
    traceEvent('context.projected', {
      approximateTokens: 40,
      omittedEventCount: 0,
      truncationCount: 0,
    }),
    traceEvent('tool.requested', {
      call: { id: 'call-legacy', name: 'read_file', arguments: { path: 'README.md' } },
      normalizedInput: { path: 'README.md' },
    }),
    traceEvent('tool.completed', {
      durationMs: 4,
      result: toolResult('completed', {
        toolCallId: 'call-legacy',
        toolName: 'read_file',
        summary: 'read README.md',
      }),
    }),
    traceEvent('turn.completed', {
      result: {
        sessionId: 'session-trace',
        turnId: 'turn-1',
        status: 'completed',
        stopReason: 'completed',
        steps: 1,
        toolCalls: 1,
      },
    }),
  ];
}
