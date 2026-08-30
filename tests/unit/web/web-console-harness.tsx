import { useSyncExternalStore } from 'react';

import { ChatView } from '../../../src/web/client/shell/chat-view.js';
import { SessionRail } from '../../../src/web/client/shell/session-rail.js';
import { SettingsModal } from '../../../src/web/client/shell/settings-modal.js';
import type { FakeTransport } from '../../../src/web/client/transport/fake-transport.js';
import type {
  WebConsoleActions,
  WebConsoleView,
} from '../../../src/web/client/view-model/console-controller.js';
import { catalogModels } from '../../../src/web/client/view-model/provider-catalog.js';

export function fakeWebConsoleActions(transport: FakeTransport): WebConsoleActions {
  return {
    changeRuntime: (update) => {
      transport.changeRuntime(update);
    },
    respondToApproval: (decision) => {
      transport.respondToApproval(decision);
    },
    resyncFromSnapshot: () => {
      transport.resyncFromSnapshot();
    },
    loadMoreSessions: () => {
      transport.loadMoreSessions();
    },
    discoverModels: () => {
      transport.discoverModels();
    },
  };
}

export function fakeWebConsoleView(transport: FakeTransport): WebConsoleView {
  const snapshot = transport.getSnapshot();
  const error = snapshot.lastCommandError;
  const approvalError =
    error?.code === 'APPROVAL_NOT_PENDING' || error?.code === 'APPROVAL_DUPLICATE'
      ? error.message
      : undefined;
  return {
    catalogModels: catalogModels(snapshot.bootstrap.provider),
    loadingHistory: snapshot.loadingHistory,
    resyncRequired: snapshot.resyncRequired,
    hasMoreSessions: snapshot.hasMoreSessions,
    lastDiscoveredAt: snapshot.lastDiscoveredAt,
    fieldErrors: snapshot.providerFieldErrors,
    errorSummary: snapshot.providerErrorSummary,
    approvalError,
  };
}

export function ChatHarness({ transport }: { readonly transport: FakeTransport }) {
  const snapshot = useSyncExternalStore(
    transport.subscribe,
    transport.getSnapshot,
    transport.getSnapshot,
  );
  return (
    <ChatView
      actions={fakeWebConsoleActions(transport)}
      capabilities={snapshot.bootstrap.capabilities}
      composerText={snapshot.composerText}
      onCancel={() => {
        transport.cancelTurn();
      }}
      onComposerText={(text) => {
        transport.setComposerText(text);
      }}
      onSubmit={() => {
        transport.submitTurn();
      }}
      session={snapshot.selectedRuntime}
      turns={snapshot.chatTurns}
      view={fakeWebConsoleView(transport)}
    />
  );
}

export function RailHarness({ transport }: { readonly transport: FakeTransport }) {
  const snapshot = useSyncExternalStore(
    transport.subscribe,
    transport.getSnapshot,
    transport.getSnapshot,
  );
  return (
    <SessionRail
      actions={fakeWebConsoleActions(transport)}
      canCreateSession={snapshot.bootstrap.capabilities.canCreateSession}
      createBlockedReason={snapshot.bootstrap.capabilities.createSessionBlockedReason}
      onCreateSession={() => {
        transport.createSession();
      }}
      onOpenSettings={() => {
        transport.openSettings();
      }}
      onSelectSession={(id) => {
        transport.selectSession(id);
      }}
      selectedSessionId={snapshot.selectedSessionId}
      sessions={snapshot.sessions}
      view={fakeWebConsoleView(transport)}
      workspace={snapshot.bootstrap.workspace}
    />
  );
}

export function SettingsHarness({
  transport,
  returnFocusTo = null,
}: {
  readonly transport: FakeTransport;
  readonly returnFocusTo?: HTMLElement | null;
}) {
  const snapshot = useSyncExternalStore(
    transport.subscribe,
    transport.getSnapshot,
    transport.getSnapshot,
  );
  return (
    <SettingsModal
      actions={fakeWebConsoleActions(transport)}
      onChange={(draft) => {
        transport.setProviderDraft(draft);
      }}
      onClose={() => {
        transport.closeSettings();
      }}
      onSave={() => {
        transport.saveProviderDraft();
      }}
      provider={snapshot.providerDraft}
      returnFocusTo={returnFocusTo}
      view={fakeWebConsoleView(transport)}
    />
  );
}
