import type {
  ApprovalRequestDto,
  ChatToolSummaryStatus,
  ChatTurnDto,
  EchoEvent,
  RuntimeCapabilitiesDto,
  SessionPhase,
  SessionQueryView,
  SessionRuntimeDto,
  SessionSummaryDto,
  SessionViewDto,
  TurnQuery,
  WebStreamEvent,
} from '../contracts/index.js';
import { WEB_BOUNDS, isToolTerminalEvent } from '../contracts/index.js';
import { toQueryView } from '../session/session-query.js';
import { redactText } from '../session/redaction.js';
import { projectRuntimeCapabilities, type RuntimeCapabilityInput } from './runtime-capabilities.js';

const ALLOWED_CHOICES = ['deny', 'allow_once', 'allow_session'] as const;
const DEFAULT_CONTEXT_LIMIT = 256_000;

export interface ProjectionRedaction {
  readonly secrets?: readonly string[];
  readonly workspaceRoot?: string;
  readonly homeDirectory?: string;
}

export interface SessionProjectionContext {
  readonly capabilities: RuntimeCapabilityInput;
  readonly redaction: ProjectionRedaction;
  readonly activeSessionId?: string;
  readonly activeTurnId?: string;
}

export function sessionShortId(sessionId: string): string {
  const shortened = sessionId
    .replace(/^session-/u, '')
    .replaceAll('-', '')
    .slice(0, 8);
  return shortened.length === 0 ? sessionId.slice(0, 8) : shortened;
}

export function boundText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function redactBound(value: string, redaction: ProjectionRedaction, max: number): string {
  return boundText(redactText(value, redaction), max);
}

function requireText(
  value: string,
  fallback: string,
  redaction: ProjectionRedaction,
  max: number,
): string {
  const redacted = redactBound(value, redaction, max).trim();
  return redacted.length === 0 ? fallback : redacted;
}

export function sessionTitle(view: SessionQueryView, redaction: ProjectionRedaction): string {
  for (const event of view.events) {
    if (event.type !== 'turn.started') continue;
    return requireText(
      event.payload.goal,
      sessionShortId(view.sessionId),
      redaction,
      WEB_BOUNDS.titleMax,
    );
  }
  return sessionShortId(view.sessionId);
}

export function sessionPhase(
  view: SessionQueryView,
  activeSessionId: string | undefined,
  activeTurnId: string | undefined,
): SessionPhase {
  if (activeSessionId === view.sessionId && activeTurnId !== undefined) return 'running';
  if (view.runtime.activeTurnId !== undefined) return 'running';
  if (view.runtime.turnCount === 0) return 'idle';
  return view.runtime.lastTurn?.status ?? 'idle';
}

function toolNameOf(events: readonly EchoEvent[], toolCallId: string): string {
  for (const event of events) {
    if (event.type === 'model.tool_call' && event.payload.call.id === toolCallId) {
      return event.payload.call.name;
    }
    if (event.type === 'tool.requested' && event.payload.call.id === toolCallId) {
      return event.payload.call.name;
    }
    if (event.type === 'tool.started' && event.payload.toolCallId === toolCallId) {
      return event.payload.toolName;
    }
  }
  return 'tool';
}

function isSettledApproval(event: EchoEvent, toolCallId: string): boolean {
  if (isToolTerminalEvent(event) && event.payload.result.toolCallId === toolCallId) return true;
  if (event.type === 'approval.granted' && event.payload.toolCallId === toolCallId) return true;
  if (event.type === 'approval.denied' && event.payload.toolCallId === toolCallId) return true;
  return false;
}

export function pendingApprovalFrom(
  view: SessionQueryView,
  redaction: ProjectionRedaction,
): ApprovalRequestDto | undefined {
  for (let index = view.events.length - 1; index >= 0; index -= 1) {
    const event = view.events[index];
    if (event?.type !== 'approval.requested' || event.turnId === undefined) continue;
    const toolCallId = event.payload.toolCallId;
    const settled = view.events
      .slice(index + 1)
      .some((later) => isSettledApproval(later, toolCallId));
    if (settled) continue;
    const toolName = requireText(
      toolNameOf(view.events, toolCallId),
      'tool',
      redaction,
      WEB_BOUNDS.toolMax,
    );
    return {
      sessionId: view.sessionId,
      turnId: event.turnId,
      toolCallId,
      toolName,
      approvalKey: boundText(event.payload.approvalKey, WEB_BOUNDS.idMax),
      actionSummary: requireText(`Approve ${toolName}`, toolName, redaction, WEB_BOUNDS.textMax),
      riskReason: requireText(
        event.payload.reason,
        'Approval required.',
        redaction,
        WEB_BOUNDS.textMax,
      ),
      allowedChoices: ALLOWED_CHOICES,
    };
  }
  return undefined;
}

function toolStatus(events: readonly EchoEvent[], toolCallId: string): ChatToolSummaryStatus {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (isToolTerminalEvent(event) && event.payload.result.toolCallId === toolCallId) {
      return event.payload.result.status;
    }
    if (event.type === 'approval.denied' && event.payload.toolCallId === toolCallId) {
      return 'denied';
    }
    if (event.type === 'approval.requested' && event.payload.toolCallId === toolCallId) {
      return 'awaiting_approval';
    }
    if (event.type === 'tool.started' && event.payload.toolCallId === toolCallId) {
      return 'running';
    }
  }
  return 'running';
}

function toolResultSummary(
  events: readonly EchoEvent[],
  toolCallId: string,
  redaction: ProjectionRedaction,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || !isToolTerminalEvent(event)) continue;
    if (event.payload.result.toolCallId !== toolCallId) continue;
    const summary = event.payload.result.summary;
    if (typeof summary !== 'string' || summary.length === 0) return undefined;
    return redactBound(summary, redaction, WEB_BOUNDS.textMax);
  }
  return undefined;
}

export function projectChatTurn(turn: TurnQuery, redaction: ProjectionRedaction): ChatTurnDto {
  const started = turn.events.find((event) => event.type === 'turn.started');
  const userText =
    started?.type === 'turn.started'
      ? redactBound(started.payload.goal, redaction, WEB_BOUNDS.bodyMax)
      : '';
  const startedAt = started?.timestamp ?? turn.events[0]?.timestamp ?? new Date(0).toISOString();
  const responses = turn.steps.flatMap((step) => {
    const texts = step.events.filter((event) => event.type === 'model.text');
    const last = texts.at(-1);
    if (last?.type !== 'model.text') return [];
    return [
      {
        step: step.step,
        text: redactBound(last.payload.text, redaction, WEB_BOUNDS.bodyMax),
        partial: last.payload.partial === true,
      },
    ];
  });
  const seen = new Set<string>();
  const toolSummaries = [];
  for (const event of turn.events) {
    const toolCallId =
      event.type === 'model.tool_call'
        ? event.payload.call.id
        : event.type === 'tool.requested'
          ? event.payload.call.id
          : event.type === 'tool.started'
            ? event.payload.toolCallId
            : event.type === 'approval.requested'
              ? event.payload.toolCallId
              : undefined;
    if (toolCallId === undefined || seen.has(toolCallId)) continue;
    seen.add(toolCallId);
    const resultSummary = toolResultSummary(turn.events, toolCallId, redaction);
    toolSummaries.push({
      toolCallId,
      name: requireText(toolNameOf(turn.events, toolCallId), 'tool', redaction, WEB_BOUNDS.toolMax),
      status: toolStatus(turn.events, toolCallId),
      ...(resultSummary === undefined ? {} : { resultSummary }),
    });
  }
  const terminal = [...turn.events]
    .reverse()
    .find(
      (event) =>
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.cancelled',
    );
  const status =
    turn.status ??
    (terminal?.type === 'turn.completed' ||
    terminal?.type === 'turn.failed' ||
    terminal?.type === 'turn.cancelled'
      ? terminal.payload.result.status
      : 'running');
  const stopReason =
    terminal?.type === 'turn.completed' ||
    terminal?.type === 'turn.failed' ||
    terminal?.type === 'turn.cancelled'
      ? boundText(terminal.payload.result.stopReason, WEB_BOUNDS.stopReasonMax)
      : undefined;
  return {
    turnId: turn.turnId,
    startedAt,
    userText,
    responses,
    toolSummaries,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

export function projectSessionSummary(
  view: SessionQueryView,
  context: SessionProjectionContext,
): SessionSummaryDto {
  return {
    id: view.sessionId,
    shortId: sessionShortId(view.sessionId),
    title: sessionTitle(view, context.redaction),
    updatedAt: view.events.at(-1)?.timestamp ?? new Date(0).toISOString(),
    turnCount: view.runtime.turnCount,
    phase: sessionPhase(view, context.activeSessionId, context.activeTurnId),
    model: boundText(view.runtime.model.value, WEB_BOUNDS.modelMax),
    safetyMode: view.runtime.safetyMode.value,
  };
}

export function projectCapabilities(
  context: SessionProjectionContext,
  awaitingApproval: boolean,
  selectedSessionId: string | undefined,
  selectedSessionAvailable: boolean,
): RuntimeCapabilitiesDto {
  return projectRuntimeCapabilities({
    ...context.capabilities,
    selectedSessionAvailable,
    awaitingApproval,
    ...(selectedSessionId === undefined ? {} : { selectedSessionId }),
    ...(context.activeSessionId === undefined ? {} : { activeSessionId: context.activeSessionId }),
    ...(context.activeTurnId === undefined ? {} : { activeTurnId: context.activeTurnId }),
  });
}

export function projectSessionRuntime(
  view: SessionQueryView,
  context: SessionProjectionContext,
): SessionRuntimeDto {
  const pendingApproval = pendingApprovalFrom(view, context.redaction);
  return {
    ...projectSessionSummary(view, context),
    context: {
      usedApproxTokens: Math.max(0, Math.trunc(view.runtime.approximateTokens ?? 0)),
      limitApproxTokens: Math.max(
        0,
        Math.trunc(view.runtime.maxApproxTokens ?? DEFAULT_CONTEXT_LIMIT),
      ),
    },
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  };
}

export function projectSessionView(
  view: SessionQueryView,
  context: SessionProjectionContext,
  selectedSessionAvailable = true,
): SessionViewDto {
  const session = projectSessionRuntime(view, context);
  return {
    session,
    capabilities: projectCapabilities(
      context,
      session.pendingApproval !== undefined,
      view.sessionId,
      selectedSessionAvailable,
    ),
  };
}

export function viewFromEvents(
  sessionId: string,
  workspaceName: string,
  events: readonly EchoEvent[],
  context: SessionProjectionContext,
): SessionViewDto {
  return projectSessionView(toQueryView(sessionId, workspaceName, events), context);
}

export function currentChatTurn(
  view: SessionQueryView,
  redaction: ProjectionRedaction,
): ChatTurnDto | undefined {
  const turn = view.turns.at(-1);
  return turn === undefined ? undefined : projectChatTurn(turn, redaction);
}

export function projectStreamEvent(
  event: EchoEvent,
  view: SessionViewDto,
  chatTurn: ChatTurnDto | undefined,
): WebStreamEvent {
  const delta = {
    view,
    ...(chatTurn === undefined ? {} : { chatTurn }),
  };
  if (event.type === 'approval.requested' && view.session.pendingApproval !== undefined) {
    return {
      type: 'approval.pending',
      sessionId: event.sessionId,
      seq: event.sequence,
      approval: view.session.pendingApproval,
      delta,
    };
  }
  if (
    event.type === 'turn.completed' ||
    event.type === 'turn.failed' ||
    event.type === 'turn.cancelled'
  ) {
    return {
      type: 'turn.terminal',
      sessionId: event.sessionId,
      seq: event.sequence,
      turnId: event.turnId ?? view.session.id,
      status: event.payload.result.status,
      ...(event.payload.result.stopReason === undefined
        ? {}
        : { stopReason: boundText(event.payload.result.stopReason, WEB_BOUNDS.stopReasonMax) }),
      delta,
    };
  }
  return {
    type: 'session.updated',
    sessionId: event.sessionId,
    seq: event.sequence,
    delta,
  };
}

export function historyGap(events: readonly EchoEvent[], after: number): boolean {
  const following = events
    .map((event) => event.sequence)
    .filter((seq) => seq > after)
    .toSorted((left, right) => left - right);
  if (following.length === 0) return false;
  let expected = after <= 0 ? following[0] : after + 1;
  if (following[0] !== expected) return true;
  for (const seq of following) {
    if (seq !== expected) return true;
    expected = seq + 1;
  }
  return false;
}
