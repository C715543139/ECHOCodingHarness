import type {
  ApprovalChoiceDto,
  BootstrapDto,
  ChatTurnDto,
  ProviderConfigDto,
  SafetyModeDto,
  SessionRuntimeDto,
  SessionSummaryDto,
  TraceRecordDetailDto,
  TraceRecordDto,
  WebErrorCode,
} from '../../../contracts/web.js';

export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';
export type WorkspaceView = 'chat' | 'trace';

export interface CommandError {
  readonly code: WebErrorCode;
  readonly message: string;
}

export interface ConsoleSnapshot {
  readonly connection: ConnectionState;
  readonly bootstrap: BootstrapDto;
  readonly sessions: readonly SessionSummaryDto[];
  readonly selectedSessionId: string | undefined;
  readonly view: WorkspaceView;
  readonly settingsOpen: boolean;
  readonly selectedTraceRecordId: string | undefined;
  readonly chatTurns: readonly ChatTurnDto[];
  readonly traceRecords: readonly TraceRecordDto[];
  readonly inspectorDetail: TraceRecordDetailDto | undefined;
  readonly selectedRuntime: SessionRuntimeDto | undefined;
  readonly composerText: string;
  readonly providerDraft: ProviderConfigDto;
  readonly lastCommandError?: CommandError | undefined;
  readonly resyncRequired: boolean;
  readonly loadingHistory: boolean;
  readonly hasMoreSessions: boolean;
  readonly providerFieldErrors?: Readonly<Record<string, string>> | undefined;
  readonly providerErrorSummary?: string | undefined;
  readonly approvalError?: string | undefined;
  readonly lastDiscoveredAt?: string | undefined;
}

export interface WebConsoleTransport {
  readonly getSnapshot: () => ConsoleSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  start(): Promise<void>;
  dispose(): void;
  createSession(): void;
  deleteSession(id: string): Promise<void>;
  selectSession(id: string): void;
  setView(view: WorkspaceView): void;
  openSettings(): void;
  closeSettings(): void;
  selectTraceRecord(id: string | undefined): void;
  setComposerText(text: string): void;
  submitTurn(): void;
  cancelTurn(): void;
  setProviderDraft(draft: ProviderConfigDto): void;
  saveProviderDraft(): void;
  changeRuntime(update: { readonly model?: string; readonly safetyMode?: SafetyModeDto }): void;
  respondToApproval(decision: ApprovalChoiceDto): void;
  discoverModels(): void;
  loadMoreSessions(): void;
  resyncFromSnapshot(): void;
}
