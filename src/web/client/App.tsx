import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

import { ChatView } from './shell/chat-view.js';
import { ConnectionStatus } from './shell/connection-status.js';
import { InspectorPane } from './shell/inspector-pane.js';
import { INSPECTOR_DEFAULT_WIDTH, InspectorResizer } from './shell/inspector-resizer.js';
import { RAIL_DEFAULT_WIDTH, RailResizer } from './shell/rail-resizer.js';
import { SessionRail } from './shell/session-rail.js';
import { SettingsModal } from './shell/settings-modal.js';
import styles from './shell/shell.module.css';
import { TraceView } from './shell/trace-view.js';
import { createFakeTransport } from './transport/fake-transport.js';
import type { WebConsoleTransport } from './transport/types.js';
import { catalogModels } from './view-model/provider-catalog.js';

type ShellStyle = CSSProperties & {
  '--echo-inspector-width'?: string;
  '--echo-rail-width'?: string;
};

export function App({ transport }: { readonly transport?: WebConsoleTransport } = {}) {
  const [ownedTransport] = useState(() => transport ?? createFakeTransport());
  const snapshot = useSyncExternalStore(
    ownedTransport.subscribe,
    ownedTransport.getSnapshot,
    ownedTransport.getSnapshot,
  );
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT_WIDTH);
  const [inspectorWidth, setInspectorWidth] = useState(INSPECTOR_DEFAULT_WIDTH);
  const selected = snapshot.sessions.find((session) => session.id === snapshot.selectedSessionId);
  const inspectorOpen = snapshot.inspectorDetail !== undefined;
  const shellClass = `${styles.shell}${inspectorOpen ? ` ${styles.shellWithInspector}` : ''}${
    railCollapsed ? ` ${styles.shellRailCollapsed}` : ''
  }`;
  const shellStyle: ShellStyle = {
    ...(railCollapsed ? {} : { '--echo-rail-width': `${String(railWidth)}px` }),
    ...(inspectorOpen ? { '--echo-inspector-width': `${String(inspectorWidth)}px` } : {}),
  };
  const controllerView = {
    catalogModels: catalogModels(snapshot.providerDraft),
    loadingHistory: snapshot.loadingHistory,
    resyncRequired: snapshot.resyncRequired,
    hasMoreSessions: snapshot.hasMoreSessions,
    lastDiscoveredAt: snapshot.lastDiscoveredAt,
    fieldErrors: snapshot.providerFieldErrors,
    errorSummary: snapshot.providerErrorSummary,
    approvalError: snapshot.approvalError,
  };

  useEffect(() => {
    void ownedTransport.start().catch(() => undefined);
  }, [ownedTransport]);

  return (
    <div
      className={shellClass}
      style={shellStyle}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') {
          return;
        }
        if (snapshot.settingsOpen) {
          ownedTransport.closeSettings();
          return;
        }
        if (inspectorOpen) {
          ownedTransport.selectTraceRecord(undefined);
        }
      }}
    >
      <a className={styles.skipLink} href="#workspace-main">
        跳到主内容
      </a>
      <SessionRail
        canCreateSession={snapshot.bootstrap.capabilities.canCreateSession}
        collapsed={railCollapsed}
        createBlockedReason={snapshot.bootstrap.capabilities.createSessionBlockedReason}
        onToggleCollapsed={() => {
          setRailCollapsed((current) => !current);
        }}
        resizer={<RailResizer onWidth={setRailWidth} width={railWidth} />}
        onCreateSession={() => {
          ownedTransport.createSession();
        }}
        onOpenSettings={() => {
          ownedTransport.openSettings();
        }}
        settingsButtonRef={settingsButtonRef}
        onSelectSession={(id) => {
          ownedTransport.selectSession(id);
        }}
        selectedSessionId={snapshot.selectedSessionId}
        sessions={snapshot.sessions}
        workspace={snapshot.bootstrap.workspace}
        actions={ownedTransport}
        view={controllerView}
      />
      <div className={styles.workspace}>
        <header className={styles.topBar}>
          <h1 className={styles.sessionHeading}>{selected?.title ?? '未选择 Session'}</h1>
          <div aria-label="视图" className={styles.viewSwitch} role="group">
            <button
              aria-current={snapshot.view === 'chat'}
              className={styles.viewTab}
              onClick={() => {
                ownedTransport.setView('chat');
              }}
              type="button"
            >
              对话
            </button>
            <button
              aria-current={snapshot.view === 'trace'}
              className={styles.viewTab}
              onClick={() => {
                ownedTransport.setView('trace');
              }}
              type="button"
            >
              轨迹
            </button>
          </div>
          <ConnectionStatus state={snapshot.connection} />
        </header>
        <main className={styles.main} id="workspace-main" tabIndex={-1}>
          {snapshot.view === 'chat' ? (
            <ChatView
              capabilities={snapshot.bootstrap.capabilities}
              composerText={snapshot.composerText}
              onCancel={() => {
                ownedTransport.cancelTurn();
              }}
              onComposerText={(text) => {
                ownedTransport.setComposerText(text);
              }}
              onSubmit={() => {
                ownedTransport.submitTurn();
              }}
              actions={ownedTransport}
              session={snapshot.selectedRuntime}
              turns={snapshot.chatTurns}
              view={controllerView}
            />
          ) : (
            <TraceView
              onSelectRecord={(id) => {
                ownedTransport.selectTraceRecord(id);
              }}
              records={snapshot.traceRecords}
              selectedRecordId={snapshot.selectedTraceRecordId}
            />
          )}
        </main>
      </div>
      {snapshot.inspectorDetail === undefined ? null : (
        <InspectorPane
          detail={snapshot.inspectorDetail}
          onClose={() => {
            ownedTransport.selectTraceRecord(undefined);
          }}
          resizer={<InspectorResizer onWidth={setInspectorWidth} width={inspectorWidth} />}
        />
      )}
      {snapshot.settingsOpen ? (
        <SettingsModal
          onChange={(draft) => {
            ownedTransport.setProviderDraft(draft);
          }}
          onClose={() => {
            ownedTransport.closeSettings();
          }}
          onSave={() => {
            ownedTransport.saveProviderDraft();
          }}
          provider={snapshot.providerDraft}
          returnFocusTo={settingsButtonRef.current}
          actions={ownedTransport}
          view={controllerView}
        />
      ) : null}
      <div aria-live="polite" className={styles.live}>
        {snapshot.connection === 'connected' ? '已连接' : '未连接'}
      </div>
    </div>
  );
}
