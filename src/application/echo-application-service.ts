import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ApprovalHandler } from '../agent/index.js';
import { AgentLoop } from '../agent/index.js';
import type {
  AgentResult,
  ApplicationService,
  ApprovalChoice,
  ApprovalResponseInput,
  ApprovalResponseResult,
  ContextBudget,
  ContextBuilder,
  CreateSessionInput,
  EchoEvent,
  EchoEventPayloads,
  EchoEventType,
  FullAccessConfirmation,
  ModelProvider,
  P1ConfigSource,
  ProviderIdentity,
  ResumeSessionInput,
  RunTurnInput,
  SafetyMode,
  SafetyPolicy,
  SessionId,
  SessionQueryView,
  SessionRepository,
  SessionRuntimeState,
  SessionSummary,
  ToolCallId,
  ToolLimits,
  TurnId,
} from '../contracts/index.js';
import {
  CONFIG_ERROR_CODES,
  EVENT_SCHEMA_VERSION,
  FULL_ACCESS_CONFIRMATION_SOURCES,
} from '../contracts/index.js';
import type { ToolRegistry } from '../tools/index.js';

import { configurationError, isStorageError } from '../session/errors.js';
import { providerIdentitiesEqual } from '../session/endpoint-fingerprint.js';
import { toRuntimeState } from '../session/session-query.js';
import { redactValue } from '../session/redaction.js';

export type UnattendedApproval = 'deny' | 'wait';

export interface EchoApplicationServiceOptions {
  readonly repository: SessionRepository;
  readonly provider: ModelProvider;
  readonly providerIdentity: ProviderIdentity;
  readonly tools: ToolRegistry;
  readonly policy: SafetyPolicy;
  readonly contextBuilder: ContextBuilder;
  readonly workspaceRoot: string;
  readonly maxSteps: number;
  readonly contextBudget: ContextBudget;
  readonly toolLimits: ToolLimits;
  readonly repeatedToolCallLimit?: number;
  readonly approvalHandler?: ApprovalHandler;
  readonly unattendedApproval?: UnattendedApproval;
  readonly onEvent?: (event: EchoEvent) => void | Promise<void>;
  readonly secrets?: readonly string[];
  readonly homeDirectory?: string;
  readonly idFactory?: (kind: 'session' | 'turn' | 'step' | 'event') => string;
  readonly now?: () => string;
}

interface SessionMemory {
  model: SessionRuntimeState['model'];
  safetyMode: SessionRuntimeState['safetyMode'];
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly controller: AbortController;
}

interface PendingApproval {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly approvalKey: string;
  readonly promise: Promise<ApprovalChoice>;
  readonly resolve: (choice: ApprovalChoice) => void;
  readonly reject: (error: unknown) => void;
}

function cancelledTurnError(): {
  category: 'cancelled';
  code: string;
  message: string;
  retryable: false;
} {
  return {
    category: 'cancelled',
    code: 'TURN_CANCELLED',
    message: 'The agent turn was cancelled.',
    retryable: false,
  };
}

function approvalKeyOf(
  sessionId: SessionId,
  turnId: TurnId,
  toolCallId: ToolCallId,
  approvalKey: string,
): string {
  return `${sessionId}\0${turnId}\0${toolCallId}\0${approvalKey}`;
}

function isHumanFullAccessConfirmation(
  confirmation: FullAccessConfirmation | undefined,
): confirmation is FullAccessConfirmation {
  if (confirmation === undefined || confirmation.acceptedRisk !== true) return false;
  return (FULL_ACCESS_CONFIRMATION_SOURCES as readonly string[]).includes(confirmation.source);
}

function requireFullAccessConfirmation(
  currentMode: SafetyMode | undefined,
  targetMode: SafetyMode,
  confirmation: FullAccessConfirmation | undefined,
): void {
  if (targetMode !== 'full-access' || currentMode === 'full-access') return;
  if (isHumanFullAccessConfirmation(confirmation)) return;
  throw configurationError(
    CONFIG_ERROR_CODES.fullAccessConfirmationRequired,
    'Full Access requires explicit human confirmation for this session.',
  );
}

export class EchoApplicationService implements ApplicationService {
  private readonly options: EchoApplicationServiceOptions;
  private readonly memory = new Map<SessionId, SessionMemory>();
  private readonly activeTurns = new Map<SessionId, ActiveTurn>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly settled = new Map<string, ApprovalChoice>();
  private readonly expired = new Set<string>();
  private readonly now: () => string;
  private readonly idFactory: NonNullable<EchoApplicationServiceOptions['idFactory']>;

  constructor(options: EchoApplicationServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  async createSession(input: CreateSessionInput): Promise<SessionRuntimeState> {
    this.assertWorkspace(input.workspaceRoot);
    if (!providerIdentitiesEqual(input.provider, this.options.providerIdentity)) {
      throw configurationError(
        CONFIG_ERROR_CODES.providerMismatch,
        'The session Provider does not match the current process Provider.',
      );
    }
    requireFullAccessConfirmation(undefined, input.safetyMode.value, input.fullAccessConfirmation);

    const summary = await this.options.repository.create({
      workspaceRoot: input.workspaceRoot,
      provider: input.provider,
      model: input.model.value,
      safetyMode: input.safetyMode.value,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
    });
    this.memory.set(summary.sessionId, {
      model: input.model,
      safetyMode: input.safetyMode,
    });
    const events = await this.options.repository.readAll(summary.sessionId);
    const started = events[0];
    if (started !== undefined) await this.notify(started);
    return this.runtimeFrom(summary.sessionId, events);
  }

  async resumeSession(input: ResumeSessionInput): Promise<SessionRuntimeState> {
    this.assertWorkspace(input.workspaceRoot);
    if (!providerIdentitiesEqual(input.provider, this.options.providerIdentity)) {
      throw configurationError(
        CONFIG_ERROR_CODES.providerMismatch,
        'The current Provider does not match the Provider that created this session.',
      );
    }

    const view = await this.options.repository.resume({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      provider: input.provider,
    });

    const model = view.runtime.model.value;
    const safetyMode = view.runtime.safetyMode.value;
    requireFullAccessConfirmation(
      safetyMode,
      input.cliSafetyMode ?? safetyMode,
      input.fullAccessConfirmation,
    );
    this.assertNoActiveTurnForSafetyModeChange(
      input.sessionId,
      safetyMode,
      input.cliSafetyMode ?? safetyMode,
    );
    this.memory.set(input.sessionId, {
      model: { value: model, source: 'session' },
      safetyMode: { value: safetyMode, source: 'session' },
    });

    await this.appendEvent(input.sessionId, 'session.resumed', {
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      provider: input.provider,
      model,
      safetyMode,
      turnCount: view.runtime.turnCount,
    });

    if (input.cliModel !== undefined && input.cliModel !== model) {
      await this.writeSessionModel(input.sessionId, input.cliModel, 'cli');
    }
    if (input.cliSafetyMode !== undefined && input.cliSafetyMode !== safetyMode) {
      await this.writeSessionSafetyMode(
        input.sessionId,
        input.cliSafetyMode,
        'cli',
        input.fullAccessConfirmation,
      );
    }

    return this.getRuntimeState(input.sessionId);
  }

  listSessions(workspaceRoot: string): Promise<readonly SessionSummary[]> {
    this.assertWorkspace(workspaceRoot);
    return this.options.repository.list(workspaceRoot);
  }

  getSession(sessionId: SessionId): Promise<SessionQueryView> {
    return this.options.repository.getQueryView(sessionId);
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    if (this.activeTurns.has(sessionId)) {
      throw configurationError(
        CONFIG_ERROR_CODES.sessionIncompatible,
        'An active turn must settle before its session can be deleted.',
      );
    }
    await this.options.repository.delete(sessionId);
    this.memory.delete(sessionId);
    this.clearApprovalState(sessionId);
  }

  async runTurn(input: RunTurnInput): Promise<AgentResult> {
    if (this.activeTurns.has(input.sessionId)) {
      throw configurationError(
        CONFIG_ERROR_CODES.sessionIncompatible,
        'A turn is already running for this session.',
      );
    }

    const runtime = await this.getRuntimeState(input.sessionId);
    if (runtime.activeTurnId !== undefined) {
      throw configurationError(
        CONFIG_ERROR_CODES.sessionIncompatible,
        'The session has an incomplete turn and must be resumed before starting another.',
      );
    }

    const controller = new AbortController();
    const turnIdPlaceholder = this.idFactory('turn');
    this.activeTurns.set(input.sessionId, { turnId: turnIdPlaceholder, controller });

    const onAbort = (): void => {
      controller.abort();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const loop = this.createLoop(runtime);
    try {
      const result = await loop.continueSession(input.sessionId, input.goal, controller.signal);
      const active = this.activeTurns.get(input.sessionId);
      if (active !== undefined) {
        this.activeTurns.set(input.sessionId, { turnId: result.turnId, controller });
      }
      return result;
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      this.expirePending(input.sessionId);
      this.activeTurns.delete(input.sessionId);
    }
  }

  async cancelTurn(sessionId: SessionId, turnId?: TurnId): Promise<void> {
    const active = this.activeTurns.get(sessionId);
    if (active === undefined) return;
    if (turnId !== undefined && active.turnId !== turnId && !active.turnId.startsWith('turn-')) {
      return;
    }
    active.controller.abort();
  }

  async respondToApproval(input: ApprovalResponseInput): Promise<ApprovalResponseResult> {
    const key = approvalKeyOf(input.sessionId, input.turnId, input.toolCallId, input.approvalKey);
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      this.pending.delete(key);
      this.settled.set(key, input.choice);
      pending.resolve(input.choice);
      return { outcome: 'accepted', choice: input.choice };
    }
    if (this.settled.has(key)) {
      return { outcome: 'rejected', reason: 'duplicate' };
    }
    if (this.expired.has(key)) {
      return { outcome: 'rejected', reason: 'expired' };
    }
    return { outcome: 'rejected', reason: 'not_pending' };
  }

  async setSessionModel(
    sessionId: SessionId,
    modelId: string,
    source: P1ConfigSource | 'slash' = 'session',
  ): Promise<SessionRuntimeState> {
    return this.writeSessionModel(sessionId, modelId, source);
  }

  async setSessionSafetyMode(
    sessionId: SessionId,
    mode: SafetyMode,
    fullAccessConfirmation?: FullAccessConfirmation,
    source: P1ConfigSource | 'slash' = 'session',
  ): Promise<SessionRuntimeState> {
    return this.writeSessionSafetyMode(sessionId, mode, source, fullAccessConfirmation);
  }

  async getRuntimeState(sessionId: SessionId): Promise<SessionRuntimeState> {
    const events = await this.options.repository.readAll(sessionId);
    if (events.length === 0) {
      throw configurationError(
        CONFIG_ERROR_CODES.sessionNotFound,
        'The requested session does not exist in this workspace.',
      );
    }
    const reconstructed = toRuntimeState(sessionId, this.workspaceName(), events);
    const remembered = this.memory.get(sessionId);
    if (remembered === undefined) {
      this.memory.set(sessionId, {
        model: reconstructed.model,
        safetyMode: reconstructed.safetyMode,
      });
      return reconstructed;
    }
    return {
      ...reconstructed,
      model: remembered.model,
      safetyMode: remembered.safetyMode,
    };
  }

  private runtimeSource(source: P1ConfigSource | 'slash'): P1ConfigSource {
    return source === 'slash' ? 'session' : source;
  }

  private async writeSessionModel(
    sessionId: SessionId,
    modelId: string,
    source: P1ConfigSource | 'slash',
  ): Promise<SessionRuntimeState> {
    const current = await this.getRuntimeState(sessionId);
    const runtimeSource = this.runtimeSource(source);
    if (current.model.value === modelId && current.model.source === runtimeSource) {
      return current;
    }
    const previousModel = current.model.value;
    this.memory.set(sessionId, {
      model: { value: modelId, source: runtimeSource },
      safetyMode: current.safetyMode,
    });
    if (previousModel !== modelId || current.model.source !== runtimeSource) {
      await this.appendEvent(sessionId, 'model.changed', {
        model: modelId,
        previousModel,
        source,
      });
    }
    return this.getRuntimeState(sessionId);
  }

  private async writeSessionSafetyMode(
    sessionId: SessionId,
    mode: SafetyMode,
    source: P1ConfigSource | 'slash',
    fullAccessConfirmation?: FullAccessConfirmation,
  ): Promise<SessionRuntimeState> {
    const current = await this.getRuntimeState(sessionId);
    requireFullAccessConfirmation(current.safetyMode.value, mode, fullAccessConfirmation);
    this.assertNoActiveTurnForSafetyModeChange(sessionId, current.safetyMode.value, mode);
    const runtimeSource = this.runtimeSource(source);
    if (current.safetyMode.value === mode && current.safetyMode.source === runtimeSource) {
      return current;
    }
    const previousSafetyMode = current.safetyMode.value;
    this.memory.set(sessionId, {
      model: current.model,
      safetyMode: { value: mode, source: runtimeSource },
    });
    if (previousSafetyMode !== mode || current.safetyMode.source !== runtimeSource) {
      await this.appendEvent(sessionId, 'safety.changed', {
        safetyMode: mode,
        previousSafetyMode,
        source,
      });
    }
    return this.getRuntimeState(sessionId);
  }

  private createLoop(runtime: SessionRuntimeState): AgentLoop {
    return new AgentLoop({
      provider: this.options.provider,
      providerIdentity: this.options.providerIdentity,
      model: runtime.model.value,
      tools: this.options.tools,
      policy: this.options.policy,
      contextBuilder: this.options.contextBuilder,
      sessionStore: this.options.repository,
      workspaceRoot: this.options.workspaceRoot,
      safetyMode: runtime.safetyMode.value,
      maxSteps: this.options.maxSteps,
      contextBudget: this.options.contextBudget,
      toolLimits: this.options.toolLimits,
      ...(this.options.repeatedToolCallLimit === undefined
        ? {}
        : { repeatedToolCallLimit: this.options.repeatedToolCallLimit }),
      approvalHandler: this.createApprovalHandler(runtime.sessionId),
      onEvent: (event) => this.observeLoopEvent(runtime.sessionId, event),
      ...(this.options.secrets === undefined ? {} : { secrets: this.options.secrets }),
      ...(this.options.homeDirectory === undefined
        ? {}
        : { homeDirectory: this.options.homeDirectory }),
      idFactory: this.idFactory,
      now: this.now,
    });
  }

  private createApprovalHandler(sessionId: SessionId): ApprovalHandler {
    return {
      requestApproval: async (request) => {
        if (this.options.approvalHandler === undefined) {
          if (this.options.unattendedApproval === 'wait') {
            return this.waitForApproval(sessionId, request);
          }
          return 'deny';
        }

        const key = approvalKeyOf(
          sessionId,
          request.turnId,
          request.toolCall.id,
          request.approvalKey,
        );
        const delegated = this.waitForApproval(sessionId, request);
        void this.options.approvalHandler.requestApproval(request).then(
          (choice) => {
            const pending = this.pending.get(key);
            if (pending === undefined) return;
            this.pending.delete(key);
            this.settled.set(key, choice);
            pending.resolve(choice);
          },
          (error) => {
            const pending = this.pending.get(key);
            if (pending === undefined) return;
            this.pending.delete(key);
            this.expired.add(key);
            pending.reject(error);
          },
        );
        return delegated;
      },
    };
  }

  private waitForApproval(
    sessionId: SessionId,
    request: Parameters<ApprovalHandler['requestApproval']>[0],
  ): Promise<ApprovalChoice> {
    const key = approvalKeyOf(sessionId, request.turnId, request.toolCall.id, request.approvalKey);
    const settled = this.settled.get(key);
    if (settled !== undefined) return Promise.resolve(settled);
    const pending = this.ensurePending(
      sessionId,
      request.turnId,
      request.toolCall.id,
      request.approvalKey,
    );
    const onAbort = (): void => {
      if (!this.pending.has(key)) return;
      this.pending.delete(key);
      this.expired.add(key);
      pending.reject(cancelledTurnError());
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    return pending.promise;
  }

  private ensurePending(
    sessionId: SessionId,
    turnId: TurnId,
    toolCallId: ToolCallId,
    approvalKey: string,
  ): PendingApproval {
    const key = approvalKeyOf(sessionId, turnId, toolCallId, approvalKey);
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    let resolve!: (choice: ApprovalChoice) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ApprovalChoice>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void promise.catch(() => undefined);
    const pending: PendingApproval = {
      sessionId,
      turnId,
      toolCallId,
      approvalKey,
      promise,
      resolve,
      reject,
    };
    this.pending.set(key, pending);
    return pending;
  }

  private observeLoopEvent(sessionId: SessionId, event: EchoEvent): void {
    const active = this.activeTurns.get(sessionId);
    if (active !== undefined && event.turnId !== undefined && event.type === 'turn.started') {
      this.activeTurns.set(sessionId, { turnId: event.turnId, controller: active.controller });
    }
    if (
      event.type === 'approval.requested' &&
      event.turnId !== undefined &&
      (this.options.unattendedApproval === 'wait' || this.options.approvalHandler !== undefined)
    ) {
      this.ensurePending(
        sessionId,
        event.turnId,
        event.payload.toolCallId,
        event.payload.approvalKey,
      );
    }
    void this.notify(event);
  }

  private expirePending(sessionId: SessionId): void {
    for (const [key, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(key);
      this.expired.add(key);
      pending.reject(cancelledTurnError());
    }
  }

  private clearApprovalState(sessionId: SessionId): void {
    const prefix = `${sessionId}\0`;
    for (const key of this.settled.keys()) {
      if (key.startsWith(prefix)) this.settled.delete(key);
    }
    for (const key of this.expired) {
      if (key.startsWith(prefix)) this.expired.delete(key);
    }
  }

  private async appendEvent<TType extends EchoEventType>(
    sessionId: SessionId,
    type: TType,
    payload: EchoEventPayloads[TType],
  ): Promise<void> {
    const events = await this.options.repository.readAll(sessionId);
    const event = redactValue(
      {
        id: this.idFactory('event'),
        sequence: (events.at(-1)?.sequence ?? 0) + 1,
        timestamp: this.now(),
        sessionId,
        type,
        payload,
      },
      {
        workspaceRoot: this.options.workspaceRoot,
        ...(this.options.secrets === undefined ? {} : { secrets: this.options.secrets }),
        ...(this.options.homeDirectory === undefined
          ? {}
          : { homeDirectory: this.options.homeDirectory }),
      },
    ) as EchoEvent;
    try {
      await this.options.repository.append(event);
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw error;
    }
    await this.notify(event);
  }

  private async notify(event: EchoEvent): Promise<void> {
    try {
      await this.options.onEvent?.(event);
    } catch {
      // Rendering failures must not change application state.
    }
  }

  private runtimeFrom(sessionId: SessionId, events: readonly EchoEvent[]): SessionRuntimeState {
    const reconstructed = toRuntimeState(sessionId, this.workspaceName(), events);
    const remembered = this.memory.get(sessionId);
    if (remembered === undefined) return reconstructed;
    return {
      ...reconstructed,
      model: remembered.model,
      safetyMode: remembered.safetyMode,
    };
  }

  private workspaceName(): string {
    const segments = this.options.workspaceRoot.split(/[/\\]/u).filter((part) => part.length > 0);
    return segments.at(-1) ?? 'workspace';
  }

  private assertWorkspace(workspaceRoot: string): void {
    if (path.resolve(workspaceRoot) !== path.resolve(this.options.workspaceRoot)) {
      throw configurationError(
        CONFIG_ERROR_CODES.sessionWorkspaceMismatch,
        'The session belongs to a different workspace.',
      );
    }
  }

  private assertNoActiveTurnForSafetyModeChange(
    sessionId: SessionId,
    currentMode: SafetyMode,
    targetMode: SafetyMode,
  ): void {
    if (currentMode === targetMode || !this.activeTurns.has(sessionId)) return;
    throw configurationError(
      CONFIG_ERROR_CODES.sessionIncompatible,
      'An active turn must settle before changing its safety mode.',
    );
  }
}
