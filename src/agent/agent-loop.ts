import { randomUUID } from 'node:crypto';

import type {
  AgentResult,
  AgentStopReason,
  ApprovalChoice,
  ContextBudget,
  ContextBuilder,
  EchoError,
  EchoEvent,
  EchoEventPayloads,
  EchoEventType,
  ModelFinishReason,
  ModelProvider,
  ModelReasoning,
  ModelReasoningDelta,
  ModelToolCall,
  ProviderIdentity,
  SafetyMode,
  SafetyPolicy,
  SessionId,
  SessionStore,
  StepId,
  ToolLimits,
  ToolResultMessage,
  TurnId,
} from '../contracts/index.js';
import { EVENT_SCHEMA_VERSION, isToolTerminalEvent } from '../contracts/index.js';
import { aggregateReasoning } from '../provider/reasoning.js';
import { redactValue, type RedactionOptions } from '../session/index.js';
import { normalizeToolInput, toolCallSignature } from '../tools/tool-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

export interface ApprovalRequest {
  readonly toolCall: ModelToolCall;
  readonly normalizedInput: unknown;
  readonly reason: string;
  readonly approvalKey: string;
  readonly signal: AbortSignal;
  readonly turnId: TurnId;
}

export interface ApprovalHandler {
  requestApproval(request: ApprovalRequest): Promise<ApprovalChoice>;
}

export interface AgentLoopOptions extends RedactionOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly tools: ToolRegistry;
  readonly policy: SafetyPolicy;
  readonly contextBuilder: ContextBuilder;
  readonly sessionStore: SessionStore;
  readonly workspaceRoot: string;
  readonly safetyMode: SafetyMode;
  readonly maxSteps: number;
  readonly repeatedToolCallLimit?: number;
  readonly contextBudget: ContextBudget;
  readonly toolLimits: ToolLimits;
  readonly approvalHandler?: ApprovalHandler;
  readonly providerIdentity?: ProviderIdentity;
  readonly onEvent?: (event: EchoEvent) => void | Promise<void>;
  readonly idFactory?: (kind: 'session' | 'turn' | 'step' | 'event') => string;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
}

interface TurnState {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly events: EchoEvent[];
  readonly approvals: Set<string>;
  readonly signatures: Map<string, number>;
  readonly seenToolCallIds: Set<string>;
  sequence: number;
  steps: number;
  toolCalls: number;
}

interface ToolStop {
  readonly reason: 'policy_denied' | 'repeated_tool_call' | 'cancelled' | 'tool_error';
  readonly error?: EchoError;
}

function defaultIdFactory(kind: 'session' | 'turn' | 'step' | 'event'): string {
  return `${kind}-${randomUUID()}`;
}

function isEchoError(value: unknown): value is EchoError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record['category'] === 'string' &&
    typeof record['code'] === 'string' &&
    typeof record['message'] === 'string' &&
    typeof record['retryable'] === 'boolean'
  );
}

function errorFromUnknown(error: unknown, fallback: EchoError): EchoError {
  return isEchoError(error) ? error : { ...fallback, cause: error };
}

function cancelledError(message = 'The agent turn was cancelled.'): EchoError {
  return {
    category: 'cancelled',
    code: 'TURN_CANCELLED',
    message,
    retryable: false,
  };
}

function toolError(code: string, message: string, cause?: unknown): EchoError {
  return {
    category: 'tool_execution',
    code,
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  };
}

function policyError(message: string): EchoError {
  return {
    category: 'policy_denied',
    code: 'POLICY_DENIED',
    message,
    retryable: false,
  };
}

function providerProtocolError(code: string, message: string): EchoError {
  return {
    category: 'provider_protocol',
    code,
    message,
    retryable: false,
  };
}

function visibleTextOf(parts: readonly string[]): string {
  return parts.join('');
}

function hasVisibleText(text: string): boolean {
  return text.length > 0;
}

function validateToolCallIds(
  calls: readonly ModelToolCall[],
  seenToolCallIds: ReadonlySet<string>,
): EchoError | undefined {
  const responseIds = new Set<string>();
  for (const call of calls) {
    if (typeof call.id !== 'string' || call.id.trim().length === 0) {
      return {
        category: 'provider_protocol',
        code: 'PROVIDER_INVALID_TOOL_CALL_ID',
        message: 'The model returned a tool call without a non-empty identifier.',
        retryable: false,
      };
    }
    if (seenToolCallIds.has(call.id) || responseIds.has(call.id)) {
      return {
        category: 'provider_protocol',
        code: 'PROVIDER_DUPLICATE_TOOL_CALL_ID',
        message: 'The model reused a tool-call identifier within the current session.',
        retryable: false,
      };
    }
    responseIds.add(call.id);
  }
  return undefined;
}

function boundedText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const marker = '\n...[truncated]...\n';
  const kept = Math.max(0, limit - marker.length);
  const head = Math.ceil(kept / 2);
  return {
    text: `${text.slice(0, head)}${marker}${text.slice(text.length - (kept - head))}`,
    truncated: true,
  };
}

function primitiveMetadata(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      metadata[key] = item;
    if (typeof item === 'number' && Number.isFinite(item)) metadata[key] = item;
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function completedResult(
  call: ModelToolCall,
  execution: Readonly<{ summary: string; data: unknown; truncated: boolean }>,
  maxOutputChars: number,
): ToolResultMessage<'completed'> {
  const serialized = boundedText(JSON.stringify(execution.data), maxOutputChars);
  const metadata = primitiveMetadata(execution.data);
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: 'completed',
    summary: execution.summary,
    content: serialized.text,
    ...(metadata === undefined ? {} : { metadata }),
    truncated: execution.truncated || serialized.truncated,
  };
}

function failedResult(
  call: ModelToolCall,
  error: EchoError,
  summary = error.message,
): ToolResultMessage<'failed'> {
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: 'failed',
    summary,
    metadata: { category: error.category, code: error.code },
    truncated: false,
  };
}

function deniedResult(call: ModelToolCall, summary: string): ToolResultMessage<'denied'> {
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: 'denied',
    summary,
    truncated: false,
  };
}

function cancelledResult(call: ModelToolCall, summary: string): ToolResultMessage<'cancelled'> {
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: 'cancelled',
    summary,
    truncated: false,
  };
}

export class AgentLoop {
  private readonly options: AgentLoopOptions;
  private readonly idFactory: NonNullable<AgentLoopOptions['idFactory']>;
  private readonly now: NonNullable<AgentLoopOptions['now']>;
  private readonly monotonicNow: NonNullable<AgentLoopOptions['monotonicNow']>;

  constructor(options: AgentLoopOptions) {
    if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1) {
      throw new RangeError('maxSteps must be a positive safe integer.');
    }
    if (
      options.repeatedToolCallLimit !== undefined &&
      (!Number.isSafeInteger(options.repeatedToolCallLimit) || options.repeatedToolCallLimit < 2)
    ) {
      throw new RangeError('repeatedToolCallLimit must be at least 2.');
    }
    this.options = options;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.now = options.now ?? (() => new Date().toISOString());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async run(
    goal: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AgentResult> {
    const state = this.createState(this.idFactory('session'));
    try {
      await this.emit(state, 'session.started', this.sessionStartedPayload());
      return await this.executeTurn(state, goal, signal);
    } catch (error) {
      return this.handleTurnException(state, error);
    }
  }

  async continueSession(
    sessionId: SessionId,
    goal: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AgentResult> {
    const prior = await this.readPersistedEvents(sessionId);
    if (prior === undefined || prior.length === 0) {
      throw {
        category: 'storage',
        code: 'SESSION_NOT_FOUND',
        message: 'The session event log could not be loaded for a continued turn.',
        retryable: false,
      } satisfies EchoError;
    }
    const state = this.createState(sessionId, prior);
    try {
      return await this.executeTurn(state, goal, signal);
    } catch (error) {
      return this.handleTurnException(state, error);
    }
  }

  private createState(sessionId: SessionId, prior: readonly EchoEvent[] = []): TurnState {
    const approvals = new Set<string>();
    const seenToolCallIds = new Set<string>();
    for (const event of prior) {
      if (event.type === 'approval.granted' && event.payload.scope === 'session') {
        approvals.add(event.payload.approvalKey);
      }
      if (event.type === 'model.tool_call') seenToolCallIds.add(event.payload.call.id);
      if (event.type === 'tool.requested') seenToolCallIds.add(event.payload.call.id);
    }
    return {
      sessionId,
      turnId: this.idFactory('turn'),
      events: [...prior],
      approvals,
      signatures: new Map<string, number>(),
      seenToolCallIds,
      sequence: prior.at(-1)?.sequence ?? 0,
      steps: 0,
      toolCalls: 0,
    };
  }

  private sessionStartedPayload(): EchoEventPayloads['session.started'] {
    return {
      workspace: '.',
      safetyMode: this.options.safetyMode,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      model: this.options.model,
      ...(this.options.providerIdentity === undefined
        ? {}
        : { provider: this.options.providerIdentity }),
    };
  }

  private async executeTurn(
    state: TurnState,
    goal: string,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    await this.emit(state, 'turn.started', { goal }, undefined, state.turnId);
    return this.runSteps(state, signal);
  }

  private async handleTurnException(state: TurnState, error: unknown): Promise<AgentResult> {
    const normalized = errorFromUnknown(
      error,
      toolError('AGENT_LOOP_FAILED', 'The agent loop stopped because of an internal error.'),
    );
    const result: AgentResult = {
      sessionId: state.sessionId,
      turnId: state.turnId,
      status: normalized.category === 'cancelled' ? 'cancelled' : 'failed',
      stopReason: normalized.category === 'cancelled' ? 'cancelled' : 'tool_error',
      steps: state.steps,
      toolCalls: state.toolCalls,
      error: normalized,
    };
    if (normalized.category === 'storage') {
      await this.repairStorageFailure(state, result, normalized);
    }
    return result;
  }

  private async runSteps(state: TurnState, signal: AbortSignal): Promise<AgentResult> {
    for (let step = 1; step <= this.options.maxSteps; step += 1) {
      if (signal.aborted) return this.finishCancelled(state);
      state.steps = step;
      const stepId = this.idFactory('step') as StepId;
      await this.emit(state, 'step.started', { step }, stepId, state.turnId);

      let projection;
      try {
        projection = this.options.contextBuilder.build(state.events, this.options.contextBudget);
      } catch (error) {
        const normalized = errorFromUnknown(
          error,
          providerProtocolError(
            'CONTEXT_ATOMIC_GROUP_EXCEEDED',
            'The current turn reasoning, tool calls, and tool results cannot fit in the remaining approximate context budget.',
          ),
        );
        if (normalized.category === 'storage' && normalized.code === 'SESSION_LOG_INVALID') {
          return this.finishFailed(state, 'provider_error', normalized);
        }
        await this.emit(
          state,
          'limit.reached',
          { kind: 'context_budget', limit: this.options.contextBudget.maxApproxTokens },
          stepId,
          state.turnId,
        );
        return this.finishFailed(state, 'provider_error', normalized);
      }
      await this.emit(
        state,
        'context.projected',
        {
          approximateTokens: projection.approximateTokens,
          omittedEventCount: projection.omittedEventCount,
          truncationCount: projection.truncations.length,
        },
        stepId,
        state.turnId,
      );
      await this.emit(
        state,
        'model.started',
        {
          provider: this.options.provider.name,
          model: this.options.model,
          ...(this.options.providerIdentity === undefined
            ? {}
            : { endpointFingerprint: this.options.providerIdentity.endpointFingerprint }),
        },
        stepId,
        state.turnId,
      );

      const text: string[] = [];
      const calls: ModelToolCall[] = [];
      const reasoningDeltas: ModelReasoningDelta[] = [];
      let finishReason: ModelFinishReason | undefined;
      let usage: { inputTokens?: number; outputTokens?: number } = {};
      try {
        for await (const streamEvent of this.options.provider.stream(
          {
            model: this.options.model,
            messages: projection.messages,
            tools: this.options.tools.definitions(),
            maxOutputTokens: this.options.contextBudget.reservedOutputTokens,
          },
          { signal },
        )) {
          if (streamEvent.type === 'text_delta') {
            text.push(streamEvent.delta);
          } else if (streamEvent.type === 'reasoning_delta') {
            reasoningDeltas.push(streamEvent.delta);
          } else if (streamEvent.type === 'tool_call') {
            calls.push(streamEvent.call);
          } else if (streamEvent.type === 'usage') {
            usage = {
              ...(streamEvent.inputTokens === undefined
                ? {}
                : { inputTokens: streamEvent.inputTokens }),
              ...(streamEvent.outputTokens === undefined
                ? {}
                : { outputTokens: streamEvent.outputTokens }),
            };
          } else if (streamEvent.type === 'completed') {
            finishReason = streamEvent.finishReason;
          }
        }
        if (finishReason === undefined) {
          throw {
            category: 'provider_protocol',
            code: 'PROVIDER_STREAM_INCOMPLETE',
            message: 'The model stream ended without a completion event.',
            retryable: false,
          } satisfies EchoError;
        }
      } catch (error) {
        const normalized = errorFromUnknown(error, {
          category: 'provider_protocol',
          code: 'PROVIDER_STREAM_FAILED',
          message: 'The model request failed.',
          retryable: false,
        });
        await this.persistReasoning(state, reasoningDeltas, stepId);
        await this.persistText(state, text, stepId, true);
        await this.emit(state, 'model.failed', { error: normalized }, stepId, state.turnId);
        if (normalized.category === 'cancelled' || signal.aborted) {
          return this.finishCancelled(
            state,
            normalized.category === 'cancelled' ? normalized : cancelledError(),
          );
        }
        return this.finishFailed(state, 'provider_error', normalized);
      }

      const aggregated = await this.persistReasoning(state, reasoningDeltas, stepId);
      await this.persistText(state, text, stepId, false);
      const toolCallIdError = validateToolCallIds(calls, state.seenToolCallIds);
      if (toolCallIdError !== undefined) {
        await this.emit(state, 'model.failed', { error: toolCallIdError }, stepId, state.turnId);
        return this.finishFailed(state, 'provider_error', toolCallIdError);
      }
      for (const call of calls) {
        state.seenToolCallIds.add(call.id);
        await this.emit(state, 'model.tool_call', { call }, stepId, state.turnId);
      }

      await this.emit(state, 'model.completed', { finishReason, ...usage }, stepId, state.turnId);

      const visibleText = visibleTextOf(text);
      const hasText = hasVisibleText(visibleText);
      const hasTools = calls.length > 0;
      const hasReasoning = aggregated !== undefined;

      if (finishReason === 'content_filter') {
        return this.finishFailed(
          state,
          'provider_error',
          providerProtocolError(
            'PROVIDER_CONTENT_FILTERED',
            'The model response was blocked by the provider content filter.',
          ),
        );
      }

      if (hasTools && finishReason === 'length') {
        return this.finishLimited(
          state,
          'output_limit',
          hasText ? visibleText : undefined,
          providerProtocolError('PROVIDER_OUTPUT_LIMIT', 'The response may be incomplete.'),
        );
      }

      if (hasTools) {
        // Complete tool calls may arrive with stop or unknown finish reasons.
      } else if (hasText && finishReason === 'length') {
        return this.finishLimited(
          state,
          'output_limit',
          visibleText,
          providerProtocolError('PROVIDER_OUTPUT_LIMIT', 'The response may be incomplete.'),
        );
      } else if (hasText) {
        const result: AgentResult = {
          sessionId: state.sessionId,
          turnId: state.turnId,
          status: 'completed',
          stopReason: 'completed',
          finalText: visibleText,
          steps: state.steps,
          toolCalls: state.toolCalls,
        };
        await this.emit(state, 'turn.completed', { result }, undefined, state.turnId);
        return result;
      } else if (finishReason === 'length' && hasReasoning) {
        return this.finishFailed(
          state,
          'provider_error',
          providerProtocolError(
            'PROVIDER_REASONING_BUDGET_EXHAUSTED',
            'The model exhausted its output budget before producing a visible response or tool call.',
          ),
        );
      } else {
        return this.finishFailed(
          state,
          'provider_error',
          providerProtocolError('PROVIDER_EMPTY_RESPONSE', 'The model returned an empty response.'),
        );
      }

      for (const call of calls) {
        const stop = await this.dispatchTool(state, stepId, call, signal);
        if (stop !== undefined) {
          if (stop.reason === 'cancelled') return this.finishCancelled(state, stop.error);
          if (stop.reason === 'repeated_tool_call') return this.finishLimited(state, stop.reason);
          return this.finishFailed(state, stop.reason, stop.error);
        }
      }

      if (step === this.options.maxSteps) {
        await this.emit(
          state,
          'limit.reached',
          { kind: 'max_steps', limit: this.options.maxSteps },
          stepId,
          state.turnId,
        );
        return this.finishLimited(state, 'max_steps');
      }
    }
    return this.finishLimited(state, 'max_steps');
  }

  private async dispatchTool(
    state: TurnState,
    stepId: StepId,
    call: ModelToolCall,
    signal: AbortSignal,
  ): Promise<ToolStop | undefined> {
    if (signal.aborted) return { reason: 'cancelled', error: cancelledError() };
    state.toolCalls += 1;
    const normalization = normalizeToolInput(call.arguments);
    const normalizedInput = normalization.ok ? normalization.value : null;
    await this.emit(state, 'tool.requested', { call, normalizedInput }, stepId, state.turnId);

    if (!normalization.ok) {
      await this.emit(
        state,
        'tool.failed',
        { result: failedResult(call, normalization.error), durationMs: 0 },
        stepId,
        state.turnId,
      );
      return undefined;
    }
    if (!this.options.tools.has(call.name)) {
      const error: EchoError = {
        category: 'invalid_tool_input',
        code: 'TOOL_NOT_REGISTERED',
        message: `Tool "${call.name}" is not registered.`,
        retryable: false,
      };
      await this.emit(
        state,
        'tool.failed',
        { result: failedResult(call, error), durationMs: 0 },
        stepId,
        state.turnId,
      );
      return undefined;
    }

    const signature = toolCallSignature(call.name, normalization.value);
    const repeated = (state.signatures.get(signature) ?? 0) + 1;
    state.signatures.set(signature, repeated);
    const repeatLimit = this.options.repeatedToolCallLimit ?? 3;
    if (repeated >= repeatLimit) {
      const summary = `Equivalent tool call repeated ${String(repeated)} times.`;
      await this.emit(
        state,
        'limit.reached',
        { kind: 'repeated_tool_call', limit: repeatLimit },
        stepId,
        state.turnId,
      );
      await this.emit(
        state,
        'tool.denied',
        { result: deniedResult(call, summary), hard: false },
        stepId,
        state.turnId,
      );
      return { reason: 'repeated_tool_call' };
    }

    let decision;
    try {
      decision = await this.options.policy.evaluate({
        mode: this.options.safetyMode,
        toolName: call.name,
        normalizedInput: normalization.value,
        workspaceRoot: this.options.workspaceRoot,
        sessionApprovals: state.approvals,
      });
    } catch (error) {
      const normalized = toolError(
        'POLICY_EVALUATION_FAILED',
        'The safety policy could not evaluate the tool request.',
        error,
      );
      await this.emit(
        state,
        'tool.failed',
        { result: failedResult(call, normalized), durationMs: 0 },
        stepId,
        state.turnId,
      );
      return { reason: 'tool_error', error: normalized };
    }

    if (decision.action === 'deny') {
      await this.emit(
        state,
        'tool.denied',
        {
          result: deniedResult(call, decision.reason),
          hard: decision.hard,
          policyRuleId: decision.ruleId,
        },
        stepId,
        state.turnId,
      );
      return { reason: 'policy_denied', error: policyError(decision.reason) };
    }

    let source: 'policy' | 'approval' = 'policy';
    if (decision.action === 'ask') {
      await this.emit(
        state,
        'approval.requested',
        {
          toolCallId: call.id,
          reason: decision.reason,
          approvalKey: decision.approvalKey,
          policyRuleId: decision.ruleId,
        },
        stepId,
        state.turnId,
      );
      if (signal.aborted) {
        await this.emit(
          state,
          'tool.cancelled',
          {
            result: cancelledResult(call, 'Cancelled while awaiting approval.'),
            phase: 'approval',
          },
          stepId,
          state.turnId,
        );
        return { reason: 'cancelled', error: cancelledError() };
      }
      let choice: ApprovalChoice;
      try {
        choice =
          this.options.approvalHandler === undefined
            ? 'deny'
            : await this.options.approvalHandler.requestApproval({
                toolCall: call,
                normalizedInput: normalization.value,
                reason: decision.reason,
                approvalKey: decision.approvalKey,
                signal,
                turnId: state.turnId,
              });
      } catch (error) {
        if (signal.aborted) {
          await this.emit(
            state,
            'tool.cancelled',
            {
              result: cancelledResult(call, 'Cancelled while awaiting approval.'),
              phase: 'approval',
            },
            stepId,
            state.turnId,
          );
          return { reason: 'cancelled', error: cancelledError() };
        }
        const normalized = toolError(
          'APPROVAL_FAILED',
          'The approval request could not be completed.',
          error,
        );
        await this.emit(
          state,
          'approval.denied',
          {
            toolCallId: call.id,
            reason: normalized.message,
            policyRuleId: decision.ruleId,
            outcome: 'failed',
          },
          stepId,
          state.turnId,
        );
        await this.emit(
          state,
          'tool.denied',
          {
            result: deniedResult(call, normalized.message),
            hard: false,
            policyRuleId: decision.ruleId,
          },
          stepId,
          state.turnId,
        );
        return { reason: 'tool_error', error: normalized };
      }
      if (choice === 'deny') {
        const reason =
          this.options.approvalHandler === undefined
            ? 'Approval is required and non-interactive execution defaults to deny.'
            : 'The user denied this operation.';
        await this.emit(
          state,
          'approval.denied',
          { toolCallId: call.id, reason, policyRuleId: decision.ruleId, outcome: 'denied' },
          stepId,
          state.turnId,
        );
        await this.emit(
          state,
          'tool.denied',
          {
            result: deniedResult(call, reason),
            hard: false,
            policyRuleId: decision.ruleId,
          },
          stepId,
          state.turnId,
        );
        return { reason: 'policy_denied', error: policyError(reason) };
      }
      if (choice === 'session') state.approvals.add(decision.approvalKey);
      await this.emit(
        state,
        'approval.granted',
        {
          toolCallId: call.id,
          approvalKey: decision.approvalKey,
          scope: choice === 'session' ? 'session' : 'once',
        },
        stepId,
        state.turnId,
      );
      source = 'approval';
    }

    await this.emit(
      state,
      'tool.authorized',
      {
        toolCallId: call.id,
        source,
        policyRuleId: decision.ruleId,
        reason: decision.reason,
      },
      stepId,
      state.turnId,
    );
    if (signal.aborted) {
      await this.emit(
        state,
        'tool.cancelled',
        { result: cancelledResult(call, 'Cancelled before tool execution.'), phase: 'authorized' },
        stepId,
        state.turnId,
      );
      return { reason: 'cancelled', error: cancelledError() };
    }

    await this.emit(
      state,
      'tool.started',
      { toolCallId: call.id, toolName: call.name },
      stepId,
      state.turnId,
    );
    const started = this.monotonicNow();
    try {
      const execution = await this.options.tools.execute(call.name, normalization.value, {
        sessionId: state.sessionId,
        turnId: state.turnId,
        stepId,
        toolCallId: call.id,
        workspaceRoot: this.options.workspaceRoot,
        signal,
        limits: this.options.toolLimits,
      });
      const durationMs = Math.max(0, Math.round(this.monotonicNow() - started));
      if (execution === undefined) {
        throw toolError('TOOL_NOT_REGISTERED', `Tool "${call.name}" is not registered.`);
      }
      if (
        signal.aborted ||
        (execution.status === 'failed' && execution.error.category === 'cancelled')
      ) {
        await this.emit(
          state,
          'tool.cancelled',
          { result: cancelledResult(call, execution.summary), phase: 'execution' },
          stepId,
          state.turnId,
        );
        return { reason: 'cancelled', error: cancelledError(execution.summary) };
      }
      if (execution.status === 'failed') {
        await this.emit(
          state,
          'tool.failed',
          { result: failedResult(call, execution.error, execution.summary), durationMs },
          stepId,
          state.turnId,
        );
        return undefined;
      }
      await this.emit(
        state,
        'tool.completed',
        {
          result: completedResult(call, execution, this.options.toolLimits.maxOutputChars),
          durationMs,
        },
        stepId,
        state.turnId,
      );
      return undefined;
    } catch (error) {
      const normalized = errorFromUnknown(
        error,
        toolError('TOOL_EXECUTION_THROWN', 'The tool failed unexpectedly.', error),
      );
      if (normalized.category === 'storage') throw normalized;
      const durationMs = Math.max(0, Math.round(this.monotonicNow() - started));
      if (signal.aborted || normalized.category === 'cancelled') {
        await this.emit(
          state,
          'tool.cancelled',
          { result: cancelledResult(call, normalized.message), phase: 'execution' },
          stepId,
          state.turnId,
        );
        return {
          reason: 'cancelled',
          error: normalized.category === 'cancelled' ? normalized : cancelledError(),
        };
      }
      await this.emit(
        state,
        'tool.failed',
        { result: failedResult(call, normalized), durationMs },
        stepId,
        state.turnId,
      );
      return undefined;
    }
  }

  private async finishFailed(
    state: TurnState,
    stopReason: Extract<AgentStopReason, 'policy_denied' | 'provider_error' | 'tool_error'>,
    error?: EchoError,
  ): Promise<AgentResult> {
    const result: AgentResult = {
      sessionId: state.sessionId,
      turnId: state.turnId,
      status: 'failed',
      stopReason,
      steps: state.steps,
      toolCalls: state.toolCalls,
      ...(error === undefined ? {} : { error }),
    };
    await this.emit(state, 'turn.failed', { result }, undefined, state.turnId);
    return result;
  }

  private async persistReasoning(
    state: TurnState,
    deltas: readonly ModelReasoningDelta[],
    stepId: StepId,
  ): Promise<ModelReasoning | undefined> {
    const payload = aggregateReasoning(deltas);
    if (payload === undefined) return undefined;
    await this.emit(state, 'model.reasoning', payload, stepId, state.turnId);
    return payload;
  }

  private async persistText(
    state: TurnState,
    parts: readonly string[],
    stepId: StepId,
    partial: boolean,
  ): Promise<string | undefined> {
    const text = visibleTextOf(parts);
    if (!hasVisibleText(text)) return undefined;
    await this.emit(
      state,
      'model.text',
      partial ? { text, partial: true } : { text },
      stepId,
      state.turnId,
    );
    return text;
  }

  private async finishLimited(
    state: TurnState,
    stopReason: Extract<AgentStopReason, 'max_steps' | 'repeated_tool_call' | 'output_limit'>,
    finalText?: string,
    error?: EchoError,
  ): Promise<AgentResult> {
    const result: AgentResult = {
      sessionId: state.sessionId,
      turnId: state.turnId,
      status: 'limited',
      stopReason,
      steps: state.steps,
      toolCalls: state.toolCalls,
      ...(finalText === undefined ? {} : { finalText }),
      ...(error === undefined ? {} : { error }),
    };
    await this.emit(state, 'turn.failed', { result }, undefined, state.turnId);
    return result;
  }

  private async finishCancelled(state: TurnState, error = cancelledError()): Promise<AgentResult> {
    const result: AgentResult = {
      sessionId: state.sessionId,
      turnId: state.turnId,
      status: 'cancelled',
      stopReason: 'cancelled',
      steps: state.steps,
      toolCalls: state.toolCalls,
      error,
    };
    await this.emit(state, 'turn.cancelled', { result }, undefined, state.turnId);
    return result;
  }

  private async emit<TType extends EchoEventType>(
    state: TurnState,
    type: TType,
    payload: EchoEventPayloads[TType],
    stepId?: StepId,
    turnId?: TurnId,
  ): Promise<void> {
    const event = this.createEvent(state, type, payload, stepId, turnId);
    await this.options.sessionStore.append(event);
    state.events.push(event);
    await this.notifyObserver(event);
  }

  private createEvent<TType extends EchoEventType>(
    state: TurnState,
    type: TType,
    payload: EchoEventPayloads[TType],
    stepId?: StepId,
    turnId?: TurnId,
  ): EchoEvent {
    state.sequence += 1;
    const raw = {
      id: this.idFactory('event'),
      sequence: state.sequence,
      timestamp: this.now(),
      sessionId: state.sessionId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(stepId === undefined ? {} : { stepId }),
      type,
      payload,
    } as EchoEvent;
    return redactValue(raw, {
      workspaceRoot: this.options.workspaceRoot,
      ...(this.options.secrets === undefined ? {} : { secrets: this.options.secrets }),
      ...(this.options.homeDirectory === undefined
        ? {}
        : { homeDirectory: this.options.homeDirectory }),
    }) as EchoEvent;
  }

  private async notifyObserver(event: EchoEvent): Promise<void> {
    try {
      await this.options.onEvent?.(event);
    } catch {
      // Rendering and observer failures must not change orchestration state.
    }
  }

  private async repairStorageFailure(
    state: TurnState,
    result: AgentResult,
    error: EchoError,
  ): Promise<void> {
    let persisted = await this.readPersistedEvents(state.sessionId);
    if (persisted === undefined) return;
    state.sequence = Math.max(state.sequence, ...persisted.map((event) => event.sequence));

    const terminalCallIds = new Set(
      persisted.filter(isToolTerminalEvent).map((event) => event.payload.result.toolCallId),
    );
    const repairedCallIds = new Set<string>();
    for (const event of persisted) {
      if (
        event.type !== 'tool.requested' ||
        terminalCallIds.has(event.payload.call.id) ||
        repairedCallIds.has(event.payload.call.id)
      ) {
        continue;
      }
      repairedCallIds.add(event.payload.call.id);
      const recovery = this.createEvent(
        state,
        'tool.failed',
        {
          result: failedResult(
            event.payload.call,
            error,
            'Session storage failed before the tool terminal state was durably recorded.',
          ),
          durationMs: 0,
        },
        event.stepId,
        state.turnId,
      );
      try {
        await this.options.sessionStore.append(recovery);
        state.events.push(recovery);
        persisted.push(recovery);
        terminalCallIds.add(event.payload.call.id);
        await this.notifyObserver(recovery);
      } catch {
        const refreshed = await this.readPersistedEvents(state.sessionId);
        if (refreshed !== undefined) {
          persisted = refreshed;
          for (const item of refreshed) {
            if (isToolTerminalEvent(item)) terminalCallIds.add(item.payload.result.toolCallId);
          }
        }
      }
    }

    if (
      !persisted.some(
        (event) =>
          event.type === 'turn.completed' ||
          event.type === 'turn.failed' ||
          event.type === 'turn.cancelled',
      ) &&
      persisted.some((event) => event.type === 'turn.started')
    ) {
      state.sequence = Math.max(state.sequence, ...persisted.map((event) => event.sequence));
      const recovery = this.createEvent(state, 'turn.failed', { result }, undefined, state.turnId);
      try {
        await this.options.sessionStore.append(recovery);
        state.events.push(recovery);
        await this.notifyObserver(recovery);
      } catch {
        // Recovery is best effort; never retry an append with ambiguous commit state.
      }
    }
  }

  private async readPersistedEvents(sessionId: SessionId): Promise<EchoEvent[] | undefined> {
    try {
      const events: EchoEvent[] = [];
      for await (const event of this.options.sessionStore.read(sessionId)) events.push(event);
      return events;
    } catch {
      return undefined;
    }
  }
}
