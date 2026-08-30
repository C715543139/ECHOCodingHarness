import type { ReactNode, Ref } from 'react';

import type {
  RuntimeBlockReason,
  SessionSummaryDto,
  WorkspaceSummaryDto,
} from '../../../contracts/web.js';
import {
  EMPTY_WEB_CONSOLE_VIEW,
  hasWebConsoleActions,
  type WebConsoleActions,
  type WebConsoleView,
} from '../view-model/console-controller.js';
import { Glyph } from './glyph.js';
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
  collapsed = false,
  onToggleCollapsed,
  resizer,
  onCreateSession,
  onSelectSession,
  onOpenSettings,
  actions,
  view = EMPTY_WEB_CONSOLE_VIEW,
}: {
  readonly workspace: WorkspaceSummaryDto;
  readonly sessions: readonly SessionSummaryDto[];
  readonly selectedSessionId: string | undefined;
  readonly settingsButtonRef?: Ref<HTMLButtonElement>;
  readonly canCreateSession: boolean;
  readonly createBlockedReason: RuntimeBlockReason | undefined;
  readonly collapsed?: boolean;
  readonly onToggleCollapsed?: () => void;
  readonly resizer?: ReactNode;
  readonly onCreateSession: () => void;
  readonly onSelectSession: (id: string) => void;
  readonly onOpenSettings: () => void;
  readonly actions?: WebConsoleActions;
  readonly view?: WebConsoleView;
}) {
  const blockedMessage = createBlockedMessage(createBlockedReason);
  const wired = hasWebConsoleActions(actions);
  const hasMoreSessions = view.hasMoreSessions;
  const collapseToggle =
    onToggleCollapsed === undefined ? null : (
      <button
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开会话栏' : '收起会话栏'}
        className={styles.iconButton}
        onClick={onToggleCollapsed}
        type="button"
      >
        <Glyph name={collapsed ? 'chevronRight' : 'chevronLeft'} />
      </button>
    );

  if (collapsed) {
    return (
      <nav aria-label="Session" className={`${styles.rail} ${styles.railCollapsed}`}>
        {collapseToggle}
      </nav>
    );
  }

  const workspaceRow = (
    <div className={styles.workspaceRow}>
      <div className={styles.workspaceBlock}>
        <p className={styles.workspaceCaption}>当前工作区</p>
        <p className={styles.workspaceName} data-testid="workspace-name" title={workspace.name}>
          {workspace.name}
        </p>
      </div>
    </div>
  );

  return (
    <nav aria-label="Session" className={styles.rail}>
      <div className={styles.railHeader}>
        <div className={styles.brandBlock}>
          <p className={styles.brand} id="echo-title">
            ECHO
          </p>
          <p className={styles.brandSub}>Coding Harness</p>
        </div>
        {collapseToggle}
      </div>
      <button
        className={styles.newSession}
        disabled={!canCreateSession}
        onClick={onCreateSession}
        type="button"
      >
        <Glyph name="plus" />
        新会话
      </button>
      {blockedMessage === undefined || canCreateSession ? null : (
        <p className={styles.blockReason}>{blockedMessage}</p>
      )}
      {workspaceRow}
      <p className={styles.railSectionLabel}>会话</p>
      {sessions.length === 0 ? (
        <p className={styles.emptyHint}>尚无 Session。新建会话后开始对话。</p>
      ) : (
        <ul
          className={styles.sessionList}
          onScroll={(event) => {
            if (!hasMoreSessions || !wired) {
              return;
            }
            const list = event.currentTarget;
            if (list.scrollTop + list.clientHeight >= list.scrollHeight - 8) {
              actions.loadMoreSessions();
            }
          }}
        >
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
      {hasMoreSessions ? (
        <button
          className={styles.secondaryButton}
          disabled={!wired}
          onClick={() => {
            actions?.loadMoreSessions();
          }}
          type="button"
        >
          加载更多
        </button>
      ) : null}
      <div className={styles.railFooter}>
        <button
          className={styles.settingsButton}
          onClick={onOpenSettings}
          ref={settingsButtonRef}
          type="button"
        >
          <Glyph name="gear" />
          设置
        </button>
      </div>
      {resizer}
    </nav>
  );
}
