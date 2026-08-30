import type { Ref } from 'react';

import type {
  RuntimeBlockReason,
  SessionSummaryDto,
  WorkspaceSummaryDto,
} from '../../../contracts/web.js';
import { SESSION_PHASE_LABELS } from './labels.js';
import styles from './shell.module.css';

function createBlockedMessage(reason: RuntimeBlockReason | undefined): string | undefined {
  if (reason === 'provider_unavailable') {
    return 'Provider 不可用或本地 API 不可达';
  }
  if (reason === 'service_stopping') {
    return '服务正在关闭';
  }
  return undefined;
}

export function SessionRail({
  workspace,
  sessions,
  selectedSessionId,
  settingsButtonRef,
  canCreateSession,
  createBlockedReason,
  onCreateSession,
  onSelectSession,
  onOpenSettings,
}: {
  readonly workspace: WorkspaceSummaryDto;
  readonly sessions: readonly SessionSummaryDto[];
  readonly selectedSessionId: string | undefined;
  readonly settingsButtonRef?: Ref<HTMLButtonElement>;
  readonly canCreateSession: boolean;
  readonly createBlockedReason: RuntimeBlockReason | undefined;
  readonly onCreateSession: () => void;
  readonly onSelectSession: (id: string) => void;
  readonly onOpenSettings: () => void;
}) {
  const blockedMessage = createBlockedMessage(createBlockedReason);

  return (
    <nav aria-label="Session" className={styles.rail}>
      <p className={styles.brand} id="echo-title">
        ECHO
      </p>
      <p className={styles.workspaceName} data-testid="workspace-name">
        {workspace.name}
      </p>
      <button
        className={styles.newSession}
        disabled={!canCreateSession}
        onClick={onCreateSession}
        type="button"
      >
        新会话
      </button>
      {blockedMessage === undefined || canCreateSession ? null : (
        <p className={styles.blockReason}>{blockedMessage}</p>
      )}
      {sessions.length === 0 ? (
        <p className={styles.emptyHint}>尚无 Session。新建会话后开始对话。</p>
      ) : (
        <ul className={styles.sessionList}>
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                aria-current={session.id === selectedSessionId}
                className={styles.sessionButton}
                onClick={() => {
                  onSelectSession(session.id);
                }}
                title={session.title}
                type="button"
              >
                <span className={styles.sessionTitle}>{session.title}</span>
                <span className={styles.sessionMeta}>
                  {session.updatedAt.slice(0, 16).replace('T', ' ')} ·{' '}
                  {SESSION_PHASE_LABELS[session.phase]} · {session.model}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.railFooter}>
        <button
          className={styles.settingsButton}
          onClick={onOpenSettings}
          ref={settingsButtonRef}
          type="button"
        >
          设置
        </button>
      </div>
    </nav>
  );
}
