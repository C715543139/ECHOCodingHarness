import type {
  AgentResult,
  AgentStatus,
  EchoEvent,
  EchoEventType,
  EndpointFingerprint,
  P1ConfigSource,
  ProviderIdentity,
  SafetyMode,
  SessionQueryView,
  SessionRuntimeState,
  SessionSummary,
  StepQuery,
  TurnQuery,
} from '../contracts/index.js';
import {
  EVENT_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION_P0,
  isToolTerminalEvent,
} from '../contracts/index.js';

import { storageError } from './errors.js';

const KNOWN_EVENT_TYPES = {
  'session.started': true,
  'session.resumed': true,
  'turn.started': true,
  'step.started': true,
  'context.projected': true,
  'model.started': true,
  'model.text_delta': true,
  'model.tool_call': true,
  'model.completed': true,
  'model.failed': true,
  'model.changed': true,
  'safety.changed': true,
  'tool.requested': true,
  'approval.requested': true,
  'approval.granted': true,
  'approval.denied': true,
  'tool.authorized': true,
  'tool.started': true,
  'tool.completed': true,
  'tool.failed': true,
  'tool.denied': true,
  'tool.cancelled': true,
  'limit.reached': true,
  'turn.completed': true,
  'turn.failed': true,
  'turn.cancelled': true,
} as const satisfies Record<EchoEventType, true>;

const TURN_TERMINAL_TYPES = new Set<EchoEventType>([
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
]);

export function isKnownEchoEventType(type: string): type is EchoEventType {
  return Object.hasOwn(KNOWN_EVENT_TYPES, type);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderIdentity(value: unknown): value is ProviderIdentity {
  if (!isRecord(value)) return false;
  return (
    value['kind'] === 'openai-compatible' &&
    value['name'] === 'openai-compatible' &&
    typeof value['endpointFingerprint'] === 'string' &&
    /^[0-9a-f]{64}$/u.test(value['endpointFingerprint'])
  );
}

export function schemaVersionOf(events: readonly EchoEvent[]): number {
  const started = events.find((event) => event.type === 'session.started');
  if (started?.type !== 'session.started') return EVENT_SCHEMA_VERSION_P0;
  return started.payload.eventSchemaVersion ?? EVENT_SCHEMA_VERSION_P0;
}

export function assertRecoverableEvents(events: readonly EchoEvent[]): void {
  if (events.length === 0) {
    throw storageError('SESSION_LOG_INVALID', 'The session event log is empty.');
  }

  for (const event of events) {
    if (!isKnownEchoEventType(event.type)) {
      throw storageError(
        'SESSION_LOG_INCOMPATIBLE',
        'The session event log contains an unknown event type.',
      );
    }
  }

  const version = schemaVersionOf(events);
  if (version !== EVENT_SCHEMA_VERSION_P0 && version !== EVENT_SCHEMA_VERSION) {
    throw storageError(
      'SESSION_LOG_INCOMPATIBLE',
      'The session event schema version is not supported.',
    );
  }

  if (version < EVENT_SCHEMA_VERSION) {
    throw storageError(
      'SESSION_LOG_INCOMPATIBLE',
      'P0 session logs cannot be resumed because they lack a Provider identity.',
    );
  }

  const started = events.find((event) => event.type === 'session.started');
  if (started?.type !== 'session.started' || started.payload.provider === undefined) {
    throw storageError(
      'SESSION_LOG_INCOMPATIBLE',
      'The session is missing a version-2 Provider identity.',
    );
  }
  if (!isProviderIdentity(started.payload.provider)) {
    throw storageError(
      'SESSION_LOG_INCOMPATIBLE',
      'The session Provider identity is not a branded endpoint fingerprint.',
    );
  }
}

export function sessionApprovalsFrom(events: readonly EchoEvent[]): Set<string> {
  const approvals = new Set<string>();
  for (const event of events) {
    if (event.type === 'approval.granted' && event.payload.scope === 'session') {
      approvals.add(event.payload.approvalKey);
    }
  }
  return approvals;
}

export function seenToolCallIdsFrom(events: readonly EchoEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === 'model.tool_call') ids.add(event.payload.call.id);
    if (event.type === 'tool.requested') ids.add(event.payload.call.id);
  }
  return ids;
}

export function incompleteToolCallIds(events: readonly EchoEvent[]): readonly string[] {
  const terminals = new Set(
    events.filter(isToolTerminalEvent).map((event) => event.payload.result.toolCallId),
  );
  const incomplete: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool.requested') continue;
    const callId = event.payload.call.id;
    if (terminals.has(callId) || seen.has(callId)) continue;
    seen.add(callId);
    incomplete.push(callId);
  }
  return incomplete;
}

export function incompleteTurnIds(events: readonly EchoEvent[]): readonly string[] {
  const terminals = new Set(
    events.filter((event) => TURN_TERMINAL_TYPES.has(event.type)).map((event) => event.turnId),
  );
  const incomplete: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'turn.started' || event.turnId === undefined) continue;
    if (terminals.has(event.turnId) || seen.has(event.turnId)) continue;
    seen.add(event.turnId);
    incomplete.push(event.turnId);
  }
  return incomplete;
}

function lastModel(events: readonly EchoEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'model.changed') return event.payload.model;
    if (event?.type === 'session.resumed') return event.payload.model;
    if (event?.type === 'session.started' && event.payload.model !== undefined) {
      return event.payload.model;
    }
  }
  return '';
}

function lastSafetyMode(events: readonly EchoEvent[]): SafetyMode {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'safety.changed') return event.payload.safetyMode;
    if (event?.type === 'session.resumed') return event.payload.safetyMode;
    if (event?.type === 'session.started') return event.payload.safetyMode;
  }
  return 'balanced';
}

function lastSource(events: readonly EchoEvent[], kind: 'model' | 'safety'): P1ConfigSource {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (kind === 'model' && event?.type === 'model.changed') {
      return event.payload.source === 'slash' ? 'session' : event.payload.source;
    }
    if (kind === 'safety' && event?.type === 'safety.changed') {
      return event.payload.source === 'slash' ? 'session' : event.payload.source;
    }
  }
  return 'session';
}

export function providerFromEvents(events: readonly EchoEvent[]): ProviderIdentity {
  for (const event of events) {
    if (event.type === 'session.started' && event.payload.provider !== undefined) {
      return event.payload.provider;
    }
    if (event.type === 'session.resumed') return event.payload.provider;
  }
  throw storageError(
    'SESSION_LOG_INCOMPATIBLE',
    'The session is missing a version-2 Provider identity.',
  );
}

function turnStatus(events: readonly EchoEvent[]): AgentStatus | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn.completed') return event.payload.result.status;
    if (event?.type === 'turn.failed') return event.payload.result.status;
    if (event?.type === 'turn.cancelled') return event.payload.result.status;
  }
  return undefined;
}

function lastTurnSummary(turns: readonly TurnQuery[]): SessionRuntimeState['lastTurn'] | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) continue;
    for (let eventIndex = turn.events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = turn.events[eventIndex];
      if (
        event?.type !== 'turn.completed' &&
        event?.type !== 'turn.failed' &&
        event?.type !== 'turn.cancelled'
      ) {
        continue;
      }
      const result: AgentResult = event.payload.result;
      return {
        status: result.status,
        stopReason: result.stopReason,
        steps: result.steps,
        toolCalls: result.toolCalls,
      };
    }
  }
  return undefined;
}

export function toTurnQueries(events: readonly EchoEvent[]): readonly TurnQuery[] {
  const order: string[] = [];
  const grouped = new Map<string, EchoEvent[]>();
  for (const event of events) {
    if (event.turnId === undefined) continue;
    const existing = grouped.get(event.turnId);
    if (existing === undefined) {
      grouped.set(event.turnId, [event]);
      order.push(event.turnId);
    } else {
      existing.push(event);
    }
  }

  return order.map((turnId) => {
    const turnEvents = grouped.get(turnId) ?? [];
    const stepOrder: string[] = [];
    const steps = new Map<string, EchoEvent[]>();
    for (const event of turnEvents) {
      if (event.stepId === undefined) continue;
      const existing = steps.get(event.stepId);
      if (existing === undefined) {
        steps.set(event.stepId, [event]);
        stepOrder.push(event.stepId);
      } else {
        existing.push(event);
      }
    }

    const stepQueries: StepQuery[] = stepOrder.map((stepId) => {
      const stepEvents = steps.get(stepId) ?? [];
      const started = stepEvents.find((event) => event.type === 'step.started');
      return {
        stepId,
        step: started?.type === 'step.started' ? started.payload.step : 0,
        events: stepEvents,
      };
    });

    const status = turnStatus(turnEvents);
    return {
      turnId,
      ...(status === undefined ? {} : { status }),
      steps: stepQueries,
      events: turnEvents,
    };
  });
}

export function toRuntimeState(
  sessionId: string,
  workspaceName: string,
  events: readonly EchoEvent[],
): SessionRuntimeState {
  const turns = toTurnQueries(events);
  const projected = [...events].reverse().find((event) => event.type === 'context.projected');
  const incomplete = incompleteTurnIds(events);
  const lastTurn = lastTurnSummary(turns);
  const approximateTokens =
    projected?.type === 'context.projected' ? projected.payload.approximateTokens : undefined;
  const maxApproxTokens =
    projected?.type === 'context.projected' ? projected.payload.maxApproxTokens : undefined;

  return {
    sessionId,
    workspaceName,
    provider: providerFromEvents(events),
    model: { value: lastModel(events), source: lastSource(events, 'model') },
    safetyMode: { value: lastSafetyMode(events), source: lastSource(events, 'safety') },
    turnCount: turns.length,
    ...(incomplete[0] === undefined ? {} : { activeTurnId: incomplete[0] }),
    ...(approximateTokens === undefined ? {} : { approximateTokens }),
    ...(maxApproxTokens === undefined ? {} : { maxApproxTokens }),
    ...(lastTurn === undefined ? {} : { lastTurn }),
  };
}

export function toQueryView(
  sessionId: string,
  workspaceName: string,
  events: readonly EchoEvent[],
): SessionQueryView {
  return {
    sessionId,
    eventSchemaVersion: schemaVersionOf(events),
    runtime: toRuntimeState(sessionId, workspaceName, events),
    turns: toTurnQueries(events),
    events,
  };
}

export function toSessionSummary(
  sessionId: string,
  events: readonly EchoEvent[],
  fallback: Readonly<{
    updatedAt: string;
    provider: ProviderIdentity;
    model: string;
    safetyMode: SafetyMode;
    eventSchemaVersion: number;
  }>,
): SessionSummary {
  const last = events.at(-1);
  return {
    sessionId,
    updatedAt: last?.timestamp ?? fallback.updatedAt,
    turnCount: events.filter((event) => event.type === 'turn.started').length,
    eventSchemaVersion: schemaVersionOf(events) || fallback.eventSchemaVersion,
    provider: events.length === 0 ? fallback.provider : providerFromEvents(events),
    model: lastModel(events) || fallback.model,
    safetyMode: lastSafetyMode(events),
  };
}

export function fingerprintLooksLikeUrl(fingerprint: EndpointFingerprint | string): boolean {
  return /:\/\//u.test(fingerprint) || fingerprint.includes('@');
}
