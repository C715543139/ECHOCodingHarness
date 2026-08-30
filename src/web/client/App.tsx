import { useRef, useState, useSyncExternalStore } from 'react';

import { ChatView } from './shell/chat-view.js';
import { ConnectionStatus } from './shell/connection-status.js';
import { InspectorPane } from './shell/inspector-pane.js';
import { SessionRail } from './shell/session-rail.js';
import { SettingsModal } from './shell/settings-modal.js';
import styles from './shell/shell.module.css';
import { TraceView } from './shell/trace-view.js';
import { createFakeTransport, type FakeTransport } from './transport/fake-transport.js';

export function App({ transport }: { readonly transport?: FakeTransport } = {}) {
  const [ownedTransport] = useState(() => transport ?? createFakeTransport());
  const snapshot = useSyncExternalStore(
    ownedTransport.subscribe,
    ownedTransport.getSnapshot,
    ownedTransport.getSnapshot,
  );
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const selected = snapshot.sessions.find((session) => session.id === snapshot.selectedSessionId);
  const inspectorOpen = snapshot.inspectorDetail !== undefined;
  const shellClass = inspectorOpen ? `${styles.shell} ${styles.shellWithInspector}` : styles.shell;

  return (
    <div
      className={shellClass}
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
        createBlockedReason={snapshot.bootstrap.capabilities.createSessionBlockedReason}
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
              session={snapshot.selectedRuntime}
              turns={snapshot.chatTurns}
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
        />
      ) : null}
      <div aria-live="polite" className={styles.live}>
        {snapshot.connection === 'connected' ? '已连接' : '未连接'}
      </div>
    </div>
  );
}
