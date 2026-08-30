import type { ApprovalChoiceDto, SafetyModeDto } from '../../../contracts/web.js';

/**
 * Narrow Chat/Session/settings actions. Implementations may be Fake or HTTP.
 * This type must not mention FakeTransport or expose a full console snapshot.
 */
export interface WebConsoleActions {
  changeRuntime(update: { readonly model?: string; readonly safetyMode?: SafetyModeDto }): void;
  respondToApproval(decision: ApprovalChoiceDto): void;
  resyncFromSnapshot(): void;
  loadMoreSessions(): void;
  discoverModels(): void;
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
}

export const EMPTY_WEB_CONSOLE_VIEW: WebConsoleView = {
  catalogModels: [],
  loadingHistory: false,
  resyncRequired: false,
  hasMoreSessions: false,
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
