export const WEB_ERROR_CODES = [
  'AUTH_INVALID',
  'ORIGIN_REJECTED',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'SESSION_INCOMPATIBLE',
  'WORKSPACE_MISMATCH',
  'TURN_ACTIVE',
  'TURN_NOT_ACTIVE',
  'STREAM_ACTIVE',
  'APPROVAL_DUPLICATE',
  'APPROVAL_EXPIRED',
  'APPROVAL_NOT_PENDING',
  'IDEMPOTENCY_CONFLICT',
  'CONFIG_INVALID',
  'PROVIDER_UNAVAILABLE',
  'RESYNC_REQUIRED',
  'INTERNAL_ERROR',
] as const;

export type WebErrorCode = (typeof WEB_ERROR_CODES)[number];

export const WEB_STREAM_EVENT_TYPES = [
  'session.updated',
  'record.upsert',
  'approval.pending',
  'turn.terminal',
  'resync.required',
] as const;

export type WebStreamEventType = (typeof WEB_STREAM_EVENT_TYPES)[number];

export const WEB_TRANSPORT_EVENT_TYPES = ['heartbeat'] as const;

export const WEB_BOUNDS = {
  requestIdMin: 16,
  requestIdMax: 128,
  idMin: 1,
  idMax: 128,
  workspaceNameMin: 1,
  workspaceNameMax: 255,
  titleMax: 512,
  modelMax: 512,
  toolMax: 512,
  baseUrlMax: 2048,
  labelMax: 512,
  statusMax: 512,
  stopReasonMax: 512,
  textMax: 2048,
  bodyMax: 65_536,
  modelsMax: 1000,
  responsesMax: 100,
  toolSummariesMax: 200,
  traceRecordsMax: 200,
  sectionsMax: 5,
  fieldsMax: 100,
  relatedIdsMax: 100,
  sessionPageMax: 100,
  chatPageMax: 100,
  tracePageMax: 200,
} as const;

// Reject C0 controls in basename display names; the class is intentional.
// eslint-disable-next-line no-control-regex -- workspace names must reject C0 controls
export const WEB_WORKSPACE_NAME_PATTERN = /^(?!\.$)(?!\.\.$)[^/\\:\u0000-\u001F]{1,255}$/u;
export const WEB_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;

export type SessionPhase = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'limited';

export type SafetyModeDto = 'safe' | 'balanced' | 'auto';

export type RuntimeBlockReason =
  'turn_active' | 'provider_unavailable' | 'session_unavailable' | 'service_stopping';

export type ChatToolSummaryStatus =
  'running' | 'awaiting_approval' | 'completed' | 'failed' | 'denied' | 'cancelled';

export type TraceRecordType =
  'user' | 'context' | 'agent' | 'tool' | 'policy' | 'approval' | 'verification' | 'turn';

export type ApprovalChoiceDto = 'deny' | 'allow_once' | 'allow_session';

export interface ApiResponse<T> {
  readonly data: T;
  readonly requestId: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface ApiErrorResponse {
  readonly error: {
    readonly code: WebErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly fields?: Readonly<Record<string, string>>;
  };
  readonly requestId: string;
}

export interface WorkspaceSummaryDto {
  readonly name: string;
  readonly fingerprint: string;
}

export interface RuntimeCapabilitiesDto {
  readonly canCreateSession: boolean;
  readonly canSubmitTurn: boolean;
  readonly canChangeRuntime: boolean;
  readonly canCancelTurn: boolean;
  readonly canRespondToApproval: boolean;
  readonly activeSessionId?: string;
  readonly activeTurnId?: string;
  readonly createSessionBlockedReason?: RuntimeBlockReason;
  readonly submitTurnBlockedReason?: RuntimeBlockReason;
  readonly changeRuntimeBlockedReason?: RuntimeBlockReason;
}

export interface SessionSummaryDto {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly phase: SessionPhase;
  readonly model: string;
  readonly safetyMode: SafetyModeDto;
}

export interface ApprovalRequestDto {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly approvalKey: string;
  readonly actionSummary: string;
  readonly riskReason: string;
  readonly allowedChoices: readonly ['deny', 'allow_once', 'allow_session'];
}

export interface SessionRuntimeDto extends SessionSummaryDto {
  readonly context: {
    readonly usedApproxTokens: number;
    readonly limitApproxTokens: number;
  };
  readonly pendingApproval?: ApprovalRequestDto;
}

export interface SessionViewDto {
  readonly session: SessionRuntimeDto;
  readonly capabilities: RuntimeCapabilitiesDto;
}

export interface ProviderConfigDto {
  readonly baseUrl: string;
  readonly catalog:
    | { readonly source: 'discover'; readonly cachedModels: readonly string[] }
    | { readonly source: 'manual'; readonly models: readonly string[] };
  readonly defaultModel: string;
  readonly apiKeyConfigured: boolean;
  readonly writable: boolean;
}

export interface BootstrapDto {
  readonly workspace: WorkspaceSummaryDto;
  readonly provider: ProviderConfigDto;
  readonly capabilities: RuntimeCapabilitiesDto;
  readonly suggestedSessionId?: string;
}

export interface UpdateProviderConfigRequest {
  readonly baseUrl: string;
  readonly catalog:
    | { readonly source: 'discover' }
    | { readonly source: 'manual'; readonly models: readonly string[] };
  readonly defaultModel: string;
}

export interface DiscoverModelsRequest {
  readonly baseUrl: string;
}

export interface DiscoveredModelsDto {
  readonly models: readonly string[];
  readonly fetchedAt: string;
}

export interface CreateSessionRequest {
  readonly model?: string;
  readonly safetyMode?: SafetyModeDto;
}

export interface ChatTurnDto {
  readonly turnId: string;
  readonly startedAt: string;
  readonly userText: string;
  readonly responses: readonly {
    readonly step: number;
    readonly text: string;
    readonly partial: boolean;
  }[];
  readonly toolSummaries: readonly {
    readonly toolCallId: string;
    readonly name: string;
    readonly status: ChatToolSummaryStatus;
    readonly resultSummary?: string;
  }[];
  readonly status: Exclude<SessionPhase, 'idle' | 'running'> | 'running';
  readonly stopReason?: string;
}

export interface UpdateSessionRuntimeRequest {
  readonly model?: string;
  readonly safetyMode?: SafetyModeDto;
}

export interface SubmitTurnRequest {
  readonly text: string;
}

export interface AcceptedTurnDto {
  readonly sessionId: string;
  readonly turnId: string;
  readonly acceptedAt: string;
}

export interface AcceptedCancellationDto {
  readonly sessionId: string;
  readonly turnId: string;
  readonly state: 'cancelling';
}

export interface ApprovalDecisionRequest {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly decision: ApprovalChoiceDto;
}

export interface AcceptedApprovalDto {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly outcome: 'accepted';
}

export interface TraceRecordDto {
  readonly id: string;
  readonly seq: number;
  readonly turnId: string;
  readonly step?: number;
  readonly time: string;
  readonly durationMs?: number;
  readonly type: TraceRecordType;
  readonly label: string;
  readonly status: string;
  readonly parameterSummary?: string;
  readonly resultSummary?: string;
  readonly hasDetails: boolean;
}

export interface TraceRecordDetailDto extends TraceRecordDto {
  readonly sections: readonly {
    readonly key: 'metadata' | 'parameters' | 'result' | 'limits' | 'evidence';
    readonly title: string;
    readonly fields?: readonly { readonly label: string; readonly value: string }[];
    readonly code?: {
      readonly language: string;
      readonly text: string;
      readonly truncated: boolean;
    };
    readonly diff?: { readonly path: string; readonly text: string; readonly truncated: boolean };
  }[];
  readonly relatedRecordIds: readonly string[];
}

export interface ProjectionDeltaDto {
  readonly view: SessionViewDto;
  readonly chatTurn?: ChatTurnDto;
  readonly traceRecords?: readonly TraceRecordDto[];
}

export type WebStreamEvent =
  | {
      readonly type: 'session.updated' | 'record.upsert';
      readonly sessionId: string;
      readonly seq: number;
      readonly delta: ProjectionDeltaDto;
    }
  | {
      readonly type: 'approval.pending';
      readonly sessionId: string;
      readonly seq: number;
      readonly approval: ApprovalRequestDto;
      readonly delta: ProjectionDeltaDto;
    }
  | {
      readonly type: 'turn.terminal';
      readonly sessionId: string;
      readonly seq: number;
      readonly turnId: string;
      readonly status: 'completed' | 'failed' | 'cancelled' | 'limited';
      readonly stopReason?: string;
      readonly delta: ProjectionDeltaDto;
    }
  | {
      readonly type: 'resync.required';
      readonly sessionId: string;
      readonly lastAvailableSeq: number;
      readonly reason: 'history_gap' | 'projection_version_changed';
    };

export const REQUEST_ID_MIN_LENGTH = WEB_BOUNDS.requestIdMin;
export const REQUEST_ID_MAX_LENGTH = WEB_BOUNDS.requestIdMax;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/u;

export function isWebErrorCode(value: string): value is WebErrorCode {
  return (WEB_ERROR_CODES as readonly string[]).includes(value);
}

export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

export function isValidWorkspaceDisplayName(value: string): boolean {
  return WEB_WORKSPACE_NAME_PATTERN.test(value);
}

export function isWebStreamEventType(value: string): value is WebStreamEventType {
  return (WEB_STREAM_EVENT_TYPES as readonly string[]).includes(value);
}
