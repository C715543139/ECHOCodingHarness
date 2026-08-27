import type { AgentResult } from './agent.js';
import type { EchoError } from './errors.js';
import type { EventId, SessionId, StepId, ToolCallId, TurnId } from './identifiers.js';
import type { ModelFinishReason, ModelToolCall } from './model.js';
import type { SafetyMode } from './safety.js';
import type { ToolResultMessage } from './tools.js';

export interface EventEnvelope<TType extends string, TPayload> {
  readonly id: EventId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly stepId?: StepId;
  readonly type: TType;
  readonly payload: TPayload;
}

export interface EchoEventPayloads {
  readonly 'session.started': Readonly<{ workspace: string; safetyMode: SafetyMode }>;
  readonly 'turn.started': Readonly<{ goal: string }>;
  readonly 'step.started': Readonly<{ step: number }>;
  readonly 'context.projected': Readonly<{
    approximateTokens: number;
    omittedEventCount: number;
    truncationCount: number;
  }>;
  readonly 'model.started': Readonly<{ provider: string; model: string }>;
  readonly 'model.text_delta': Readonly<{ delta: string }>;
  readonly 'model.tool_call': Readonly<{ call: ModelToolCall }>;
  readonly 'model.completed': Readonly<{
    finishReason: ModelFinishReason;
    inputTokens?: number;
    outputTokens?: number;
  }>;
  readonly 'model.failed': Readonly<{ error: EchoError; attempt?: number }>;
  readonly 'tool.requested': Readonly<{
    call: ModelToolCall;
    normalizedInput: unknown;
  }>;
  readonly 'approval.requested': Readonly<{
    toolCallId: ToolCallId;
    reason: string;
    approvalKey: string;
  }>;
  readonly 'approval.granted': Readonly<{
    toolCallId: ToolCallId;
    approvalKey: string;
    scope: 'once' | 'session';
  }>;
  readonly 'approval.denied': Readonly<{ toolCallId: ToolCallId; reason: string }>;
  readonly 'tool.authorized': Readonly<{
    toolCallId: ToolCallId;
    source: 'policy' | 'approval';
  }>;
  readonly 'tool.started': Readonly<{ toolCallId: ToolCallId; toolName: string }>;
  readonly 'tool.completed': Readonly<{
    result: ToolResultMessage<'completed'>;
    durationMs: number;
  }>;
  readonly 'tool.failed': Readonly<{
    result: ToolResultMessage<'failed'>;
    durationMs: number;
  }>;
  readonly 'tool.denied': Readonly<{
    result: ToolResultMessage<'denied'>;
    hard: boolean;
  }>;
  readonly 'tool.cancelled': Readonly<{
    result: ToolResultMessage<'cancelled'>;
    phase: 'approval' | 'authorized' | 'execution';
  }>;
  readonly 'limit.reached': Readonly<{
    kind: 'max_steps' | 'repeated_tool_call' | 'context_budget';
    limit: number;
  }>;
  readonly 'turn.completed': Readonly<{ result: AgentResult }>;
  readonly 'turn.failed': Readonly<{ result: AgentResult }>;
  readonly 'turn.cancelled': Readonly<{ result: AgentResult }>;
}

export type EchoEventType = keyof EchoEventPayloads;

export type EchoEventOf<TType extends EchoEventType> = EventEnvelope<
  TType,
  EchoEventPayloads[TType]
>;

export type EchoEvent = {
  readonly [TType in EchoEventType]: EchoEventOf<TType>;
}[EchoEventType];

export type ToolTerminalEvent =
  | EchoEventOf<'tool.completed'>
  | EchoEventOf<'tool.failed'>
  | EchoEventOf<'tool.denied'>
  | EchoEventOf<'tool.cancelled'>;

export function isToolTerminalEvent(event: EchoEvent): event is ToolTerminalEvent {
  return (
    event.type === 'tool.completed' ||
    event.type === 'tool.failed' ||
    event.type === 'tool.denied' ||
    event.type === 'tool.cancelled'
  );
}
