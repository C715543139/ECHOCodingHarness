import type { AgentResult, AgentStatus } from './agent.js';
import type { P1ConfigSource } from './config.js';
import type { EchoEvent } from './events.js';
import type { ProviderIdentity, SessionId, StepId, ToolCallId, TurnId } from './identifiers.js';
import type { SafetyMode } from './safety.js';
import type { SessionStore } from './session.js';

export const EVENT_SCHEMA_VERSION_P0 = 1;
export const EVENT_SCHEMA_VERSION_P1 = 2;
export const EVENT_SCHEMA_VERSION = 3;

export interface SessionRuntimeState {
  readonly sessionId: SessionId;
  readonly workspaceName: string;
  readonly provider: ProviderIdentity;
  readonly model: EffectiveRuntimeSetting<string>;
  readonly safetyMode: EffectiveRuntimeSetting<SafetyMode>;
  readonly turnCount: number;
  readonly activeTurnId?: TurnId;
  readonly approximateTokens?: number;
  readonly maxApproxTokens?: number;
  readonly lastTurn?: Readonly<{
    status: AgentStatus;
    stopReason: AgentResult['stopReason'];
    steps: number;
    toolCalls: number;
  }>;
}

export interface EffectiveRuntimeSetting<T> {
  readonly value: T;
  readonly source: P1ConfigSource;
}

export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly eventSchemaVersion: number;
  readonly provider: ProviderIdentity;
  readonly model: string;
  readonly safetyMode: SafetyMode;
}

export interface StepQuery {
  readonly stepId: StepId;
  readonly step: number;
  readonly events: readonly EchoEvent[];
}

export interface TurnQuery {
  readonly turnId: TurnId;
  readonly status?: AgentStatus;
  readonly steps: readonly StepQuery[];
  readonly events: readonly EchoEvent[];
}

export interface SessionQueryView {
  readonly sessionId: SessionId;
  readonly eventSchemaVersion: number;
  readonly runtime: SessionRuntimeState;
  readonly turns: readonly TurnQuery[];
  readonly events: readonly EchoEvent[];
}

export interface SessionRepository extends SessionStore {
  create(input: CreateSessionRecordInput): Promise<SessionSummary>;
  resume(input: ResumeSessionRecordInput): Promise<SessionQueryView>;
  list(workspaceRoot: string): Promise<readonly SessionSummary[]>;
  readAll(sessionId: SessionId): Promise<readonly EchoEvent[]>;
  getQueryView(sessionId: SessionId): Promise<SessionQueryView>;
  delete(sessionId: SessionId): Promise<void>;
}

export interface CreateSessionRecordInput {
  readonly workspaceRoot: string;
  readonly provider: ProviderIdentity;
  readonly model: string;
  readonly safetyMode: SafetyMode;
  readonly eventSchemaVersion: number;
}

export interface ResumeSessionRecordInput {
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly provider: ProviderIdentity;
}

export interface CreateSessionInput {
  readonly workspaceRoot: string;
  readonly provider: ProviderIdentity;
  readonly model: EffectiveRuntimeSetting<string>;
  readonly safetyMode: EffectiveRuntimeSetting<SafetyMode>;
}

export interface ResumeSessionInput {
  readonly workspaceRoot: string;
  readonly sessionId: SessionId;
  readonly provider: ProviderIdentity;
  readonly cliModel?: string;
  readonly cliSafetyMode?: SafetyMode;
}

export interface RunTurnInput {
  readonly sessionId: SessionId;
  readonly goal: string;
  readonly signal?: AbortSignal;
}

export type ApprovalChoice = 'deny' | 'once' | 'session';

export interface ApprovalResponseInput {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly approvalKey: string;
  readonly choice: ApprovalChoice;
}

export type ApprovalRejectionReason = 'duplicate' | 'expired' | 'not_pending';

export type ApprovalResponseResult =
  | Readonly<{ outcome: 'accepted'; choice: ApprovalChoice }>
  | Readonly<{ outcome: 'rejected'; reason: ApprovalRejectionReason }>;

export interface ApplicationService {
  createSession(input: CreateSessionInput): Promise<SessionRuntimeState>;
  resumeSession(input: ResumeSessionInput): Promise<SessionRuntimeState>;
  listSessions(workspaceRoot: string): Promise<readonly SessionSummary[]>;
  getSession(sessionId: SessionId): Promise<SessionQueryView>;
  deleteSession(sessionId: SessionId): Promise<void>;
  runTurn(input: RunTurnInput): Promise<AgentResult>;
  cancelTurn(sessionId: SessionId, turnId?: TurnId): Promise<void>;
  respondToApproval(input: ApprovalResponseInput): Promise<ApprovalResponseResult>;
  setSessionModel(sessionId: SessionId, modelId: string): Promise<SessionRuntimeState>;
  setSessionSafetyMode(sessionId: SessionId, mode: SafetyMode): Promise<SessionRuntimeState>;
  getRuntimeState(sessionId: SessionId): Promise<SessionRuntimeState>;
}
