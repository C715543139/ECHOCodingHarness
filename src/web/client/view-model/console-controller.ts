import type {
  ApprovalChoiceDto,
  ExtensionSummaryDto,
  UpdateSessionRuntimeRequest,
} from '../../../contracts/web.js';

/**
 * Narrow Chat/Session/settings actions. Implementations may be Fake or HTTP.
 * This type must not mention FakeTransport or expose a full console snapshot.
 */
export interface WebConsoleActions {
  changeRuntime(update: UpdateSessionRuntimeRequest): void;
  respondToApproval(decision: ApprovalChoiceDto): void;
  resyncFromSnapshot(): void;
  loadMoreSessions(): void;
  discoverModels(): void;
  refreshExtensions(): void;
  enableExtension(extensionId: string): void;
  disableExtension(extensionId: string): void;
  uninstallExtension(extensionId: string): void;
}

/**
 * Readonly extras that A4 App does not pass. C1 wires these from the live adapter.
 */
export interface WebConsoleView {
  readonly catalogModels: readonly string[];
  readonly loadingHistory: boolean;
  readonly resyncRequired: boolean;
  readonly hasMoreSessions: boolean;
  readonly lastDiscoveredAt?: string | undefined;
  readonly fieldErrors?: Readonly<Record<string, string>> | undefined;
  readonly errorSummary?: string | undefined;
  readonly approvalError?: string | undefined;
  readonly extensions: readonly ExtensionSummaryDto[];
  readonly extensionsAvailable: boolean;
  readonly extensionsLoading: boolean;
  readonly extensionPendingId?: string | undefined;
  readonly extensionError?: string | undefined;
  readonly extensionNotice?: string | undefined;
}

export const EMPTY_WEB_CONSOLE_VIEW: WebConsoleView = {
  catalogModels: [],
  loadingHistory: false,
  resyncRequired: false,
  hasMoreSessions: false,
  extensions: [],
  extensionsAvailable: false,
  extensionsLoading: false,
};

/**
 * A4 App omits `actions`. Buttons that need the controller stay disabled and
 * must not invent side effects.
 */
export function hasWebConsoleActions(
  actions: WebConsoleActions | undefined,
): actions is WebConsoleActions {
  return actions !== undefined;
}
