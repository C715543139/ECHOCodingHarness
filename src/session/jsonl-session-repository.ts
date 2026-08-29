import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  CreateSessionRecordInput,
  EchoEvent,
  EchoEventPayloads,
  EchoEventType,
  ResumeSessionRecordInput,
  SessionId,
  SessionQueryView,
  SessionRepository,
  SessionSummary,
  ToolCallId,
  TurnId,
} from '../contracts/index.js';
import {
  CONFIG_ERROR_CODES,
  EVENT_SCHEMA_VERSION,
  isToolTerminalEvent,
} from '../contracts/index.js';

import { configurationError, isStorageError, storageError } from './errors.js';
import { type JsonlSessionStoreOptions, JsonlSessionStore } from './jsonl-session-store.js';
import { providerIdentitiesEqual } from './endpoint-fingerprint.js';
import {
  assertRecoverableEvents,
  incompleteTurnIds,
  providerFromEvents,
  toQueryView,
  toSessionSummary,
} from './session-query.js';

export interface JsonlSessionRepositoryOptions extends JsonlSessionStoreOptions {
  readonly now?: () => string;
  readonly idFactory?: (kind: 'session' | 'event') => string;
}

function defaultIdFactory(kind: 'session' | 'event'): string {
  return `${kind}-${randomUUID()}`;
}

function failedToolResult(callId: ToolCallId, toolName: string) {
  return {
    toolCallId: callId,
    toolName,
    status: 'failed' as const,
    summary: 'Session storage ended before the tool terminal state was durably recorded.',
    truncated: false,
  };
}

export class JsonlSessionRepository extends JsonlSessionStore implements SessionRepository {
  private readonly now: () => string;
  private readonly idFactory: (kind: 'session' | 'event') => string;

  constructor(options: JsonlSessionRepositoryOptions) {
    super(options);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  workspaceDisplayName(): string {
    const name = path.basename(this.workspaceRoot);
    return name.length === 0 ? 'workspace' : name;
  }

  private assertWorkspace(workspaceRoot: string): void {
    if (path.resolve(workspaceRoot) !== this.workspaceRoot) {
      throw configurationError(
        CONFIG_ERROR_CODES.sessionWorkspaceMismatch,
        'The session belongs to a different workspace.',
      );
    }
  }

  async readAll(sessionId: SessionId): Promise<readonly EchoEvent[]> {
    const events: EchoEvent[] = [];
    for await (const event of this.read(sessionId)) events.push(event);
    return events;
  }

  async create(input: CreateSessionRecordInput): Promise<SessionSummary> {
    this.assertWorkspace(input.workspaceRoot);
    if (input.eventSchemaVersion !== EVENT_SCHEMA_VERSION) {
      throw storageError(
        'SESSION_LOG_INCOMPATIBLE',
        'New sessions must use event schema version 2.',
      );
    }

    const sessionId = this.idFactory('session');
    const timestamp = this.now();
    const started: EchoEvent = {
      id: this.idFactory('event'),
      sequence: 1,
      timestamp,
      sessionId,
      type: 'session.started',
      payload: {
        workspace: '.',
        safetyMode: input.safetyMode,
        eventSchemaVersion: input.eventSchemaVersion,
        provider: input.provider,
        model: input.model,
      },
    };
    await this.append(started);
    return {
      sessionId,
      updatedAt: timestamp,
      turnCount: 0,
      eventSchemaVersion: input.eventSchemaVersion,
      provider: input.provider,
      model: input.model,
      safetyMode: input.safetyMode,
    };
  }

  async list(workspaceRoot: string): Promise<readonly SessionSummary[]> {
    this.assertWorkspace(workspaceRoot);
    const sessionIds = await this.listSessionIds();
    const summaries: SessionSummary[] = [];
    for (const sessionId of sessionIds) {
      try {
        const events = await this.readAll(sessionId);
        if (events.length === 0) continue;
        assertRecoverableEvents(events);
        summaries.push(
          toSessionSummary(sessionId, events, {
            updatedAt: this.now(),
            provider: providerFromEvents(events),
            model: '',
            safetyMode: 'balanced',
            eventSchemaVersion: EVENT_SCHEMA_VERSION,
          }),
        );
      } catch {
        // Listing must not fail the whole workspace because one log is unreadable.
      }
    }
    return summaries;
  }

  async getQueryView(sessionId: SessionId): Promise<SessionQueryView> {
    const events = await this.readAll(sessionId);
    if (events.length === 0) {
      throw configurationError(
        CONFIG_ERROR_CODES.sessionNotFound,
        'The requested session does not exist in this workspace.',
      );
    }
    assertRecoverableEvents(events);
    return toQueryView(sessionId, this.workspaceDisplayName(), events);
  }

  async resume(input: ResumeSessionRecordInput): Promise<SessionQueryView> {
    this.assertWorkspace(input.workspaceRoot);
    let events: EchoEvent[];
    try {
      events = [...(await this.readAll(input.sessionId))];
    } catch (error) {
      if (isStorageError(error) && error.code === 'SESSION_LOG_INVALID') {
        throw configurationError(
          CONFIG_ERROR_CODES.sessionCorrupt,
          'The session event log is damaged and cannot be replayed.',
          error,
        );
      }
      if (isStorageError(error) && error.code === 'INVALID_SESSION_ID') {
        throw configurationError(
          CONFIG_ERROR_CODES.sessionNotFound,
          'The requested session identifier is not valid.',
          error,
        );
      }
      throw error;
    }

    if (events.length === 0) {
      throw configurationError(
        CONFIG_ERROR_CODES.sessionNotFound,
        'The requested session does not exist in this workspace.',
      );
    }

    try {
      assertRecoverableEvents(events);
    } catch (error) {
      if (isStorageError(error) && error.code === 'SESSION_LOG_INCOMPATIBLE') {
        throw configurationError(CONFIG_ERROR_CODES.sessionIncompatible, error.message, error);
      }
      if (isStorageError(error) && error.code === 'SESSION_LOG_INVALID') {
        throw configurationError(
          CONFIG_ERROR_CODES.sessionCorrupt,
          'The session event log is damaged and cannot be replayed.',
          error,
        );
      }
      throw error;
    }

    const storedProvider = providerFromEvents(events);
    if (!providerIdentitiesEqual(storedProvider, input.provider)) {
      throw configurationError(
        CONFIG_ERROR_CODES.providerMismatch,
        'The current Provider does not match the Provider that created this session.',
      );
    }

    events = await this.compensateIncomplete(input.sessionId, events);
    return toQueryView(input.sessionId, this.workspaceDisplayName(), events);
  }

  private async compensateIncomplete(
    sessionId: SessionId,
    events: EchoEvent[],
  ): Promise<EchoEvent[]> {
    const repaired = [...events];
    let sequence = repaired.at(-1)?.sequence ?? 0;

    const requested = repaired.filter((event) => event.type === 'tool.requested');
    const terminalIds = new Set(
      repaired.filter(isToolTerminalEvent).map((event) => event.payload.result.toolCallId),
    );
    for (const event of requested) {
      if (event.type !== 'tool.requested') continue;
      const callId = event.payload.call.id;
      if (terminalIds.has(callId)) continue;
      sequence += 1;
      const recovery = this.recoveryEvent(
        sessionId,
        sequence,
        'tool.failed',
        {
          result: failedToolResult(callId, event.payload.call.name),
          durationMs: 0,
        },
        event.turnId,
        event.stepId,
      );
      await this.append(recovery);
      repaired.push(recovery);
      terminalIds.add(callId);
    }

    const hungTurns = incompleteTurnIds(repaired);
    for (const turnId of hungTurns) {
      const turnEvents = repaired.filter((event) => event.turnId === turnId);
      sequence += 1;
      const recovery = this.recoveryEvent(
        sessionId,
        sequence,
        'turn.failed',
        {
          result: {
            sessionId,
            turnId,
            status: 'failed',
            stopReason: 'tool_error',
            steps: turnEvents.filter((event) => event.type === 'step.started').length,
            toolCalls: turnEvents.filter((event) => event.type === 'tool.requested').length,
            error: storageError(
              'SESSION_TURN_INCOMPLETE',
              'The previous turn had no terminal event and was marked failed on resume.',
            ),
          },
        },
        turnId,
      );
      await this.append(recovery);
      repaired.push(recovery);
    }

    return repaired;
  }

  private recoveryEvent<TType extends EchoEventType>(
    sessionId: SessionId,
    sequence: number,
    type: TType,
    payload: EchoEventPayloads[TType],
    turnId?: TurnId,
    stepId?: string,
  ): EchoEvent {
    return {
      id: this.idFactory('event'),
      sequence,
      timestamp: this.now(),
      sessionId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(stepId === undefined ? {} : { stepId }),
      type,
      payload,
    } as EchoEvent;
  }
}
