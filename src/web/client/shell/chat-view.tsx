import { useLayoutEffect, useRef, useState } from 'react';

import type {
  ChatTurnDto,
  RuntimeCapabilitiesDto,
  SessionRuntimeDto,
} from '../../../contracts/web.js';
import {
  EMPTY_WEB_CONSOLE_VIEW,
  hasWebConsoleActions,
  type WebConsoleActions,
  type WebConsoleView,
} from '../view-model/console-controller.js';
import { ApprovalCard } from './approval-card.js';
import { FullAccessDialog } from './full-access-dialog.js';
import { Glyph } from './glyph.js';
import { TOOL_SUMMARY_LABELS } from './labels.js';
import { MarkdownMessage } from './markdown-message.js';
import styles from './shell.module.css';

const SAFETY_MODES = ['safe', 'balanced', 'auto', 'full-access'] as const;

function blockedMessageFor(
  reason: RuntimeCapabilitiesDto['submitTurnBlockedReason'],
): string | undefined {
  if (reason === 'turn_active') {
    return '另一会话正在运行';
  }
  if (reason === 'provider_unavailable') {
    return 'Provider 不可用或本地 API 不可达';
  }
  if (reason === 'session_unavailable') {
    return '请选择或新建会话';
  }
  if (reason === 'service_stopping') {
    return '服务正在关闭';
  }
  return undefined;
}

function liveAnnouncement(turns: readonly ChatTurnDto[], awaitingApproval: boolean): string {
  if (awaitingApproval) {
    return '等待审批';
  }
  const latest = turns.at(-1);
  if (latest === undefined || latest.status === 'running') {
    return '';
  }
  return latest.status;
}

function canSubmitComposer(capabilities: RuntimeCapabilitiesDto, composerText: string): boolean {
  return capabilities.canSubmitTurn && composerText.trim().length > 0;
}

function turnStatusLabel(turn: ChatTurnDto): string {
  return turn.stopReason === undefined || turn.stopReason === turn.status
    ? turn.status
    : `${turn.status} · ${turn.stopReason}`;
}

export function ChatView({
  session,
  turns,
  capabilities,
  composerText,
  onComposerText,
  onSubmit,
  onCancel,
  actions,
  view = EMPTY_WEB_CONSOLE_VIEW,
}: {
  readonly session: SessionRuntimeDto | undefined;
  readonly turns: readonly ChatTurnDto[];
  readonly capabilities: RuntimeCapabilitiesDto;
  readonly composerText: string;
  readonly onComposerText: (text: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly actions?: WebConsoleActions;
  readonly view?: WebConsoleView;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestTurnRef = useRef<HTMLElement>(null);
  const previousSessionStateRef = useRef<{
    readonly id: string | undefined;
    readonly phase: SessionRuntimeDto['phase'] | undefined;
  }>({ id: undefined, phase: undefined });
  const [followTail, setFollowTail] = useState(true);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const safetySelectRef = useRef<HTMLSelectElement>(null);
  const wired = hasWebConsoleActions(actions);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    const previous = previousSessionStateRef.current;
    const current = { id: session?.id, phase: session?.phase };
    previousSessionStateRef.current = current;
    if (node === null) {
      return;
    }
    const justFinished =
      previous.id === current.id &&
      previous.phase === 'running' &&
      current.phase !== undefined &&
      current.phase !== 'running';
    if (justFinished && latestTurnRef.current !== null) {
      node.scrollTop = Math.max(0, latestTurnRef.current.offsetTop - 16);
      setHasNewContent(false);
      return;
    }
    if (followTail) {
      node.scrollTop = node.scrollHeight;
      setHasNewContent(false);
      return;
    }
    setHasNewContent(true);
  }, [turns, followTail, session?.id, session?.phase]);

  if (session === undefined) {
    return (
      <div className={`${styles.scroll} ${styles.chatScroll}`}>
        <div className={styles.chatContent}>
          <p>选择或新建会话后开始对话。</p>
        </div>
      </div>
    );
  }

  const contextLabel = `${String(session.context.usedApproxTokens)} / ${String(session.context.limitApproxTokens)}`;
  const blocked = capabilities.submitTurnBlockedReason;
  const blockedMessage =
    blocked === 'turn_active' &&
    (capabilities.activeSessionId === session.id || session.phase === 'running')
      ? undefined
      : blockedMessageFor(blocked);
  const pending = session.pendingApproval;
  const models = view.catalogModels.length === 0 ? [session.model] : view.catalogModels;
  const modelOptions = models.includes(session.model) ? models : [session.model, ...models];
  const approvalError = view.approvalError;
  const submitEnabled = canSubmitComposer(capabilities, composerText);

  return (
    <>
      <div
        className={`${styles.scroll} ${styles.chatScroll}`}
        data-testid="chat-scroll"
        onScroll={(event) => {
          const node = event.currentTarget;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          setFollowTail(atBottom);
          if (atBottom) {
            setHasNewContent(false);
          }
        }}
        ref={scrollRef}
      >
        <div className={styles.chatContent} data-testid="chat-content">
          {view.loadingHistory ? <p>正在加载历史…</p> : null}
          {view.resyncRequired ? (
            <p className={styles.blockReason} data-testid="resync-banner">
              需要完整同步。已保留当前内容，不会重新提交 Turn。
              <button
                className={styles.secondaryButton}
                disabled={!wired}
                onClick={() => {
                  actions?.resyncFromSnapshot();
                }}
                type="button"
              >
                重新同步
              </button>
            </p>
          ) : null}
          {turns.length === 0 && !view.loadingHistory ? (
            <p>开始对话。历史只投影聚合 Session 事实。</p>
          ) : null}
          {turns.map((turn, index) => (
            <article
              className={styles.turn}
              data-turn-id={turn.turnId}
              key={turn.turnId}
              ref={index === turns.length - 1 ? latestTurnRef : undefined}
            >
              <h3 className={styles.srOnly}>用户</h3>
              <div className={styles.userRow}>
                <p className={styles.userBubble}>{turn.userText}</p>
              </div>
              {turn.responses.map((response) => (
                <div
                  className={styles.agentText}
                  data-partial={String(response.partial)}
                  key={response.step}
                >
                  <MarkdownMessage>{response.text}</MarkdownMessage>
                </div>
              ))}
              {turn.toolSummaries.map((summary) => (
                <p
                  className={styles.toolCard}
                  data-status={summary.status}
                  key={summary.toolCallId}
                >
                  {summary.name} · {TOOL_SUMMARY_LABELS[summary.status]}
                  {summary.resultSummary === undefined ? '' : ` · ${summary.resultSummary}`}
                </p>
              ))}
              <p className={styles.turnStatus}>{turnStatusLabel(turn)}</p>
            </article>
          ))}
        </div>
      </div>
      {pending === undefined ? (
        approvalError === undefined ? null : (
          <div className={styles.chatAuxiliary}>
            <p className={styles.blockReason}>{approvalError}</p>
          </div>
        )
      ) : (
        <div className={styles.chatAuxiliary}>
          <ApprovalCard
            approval={pending}
            disabled={!capabilities.canRespondToApproval || !wired}
            errorMessage={approvalError}
            onDecide={(decision) => {
              actions?.respondToApproval(decision);
            }}
          />
        </div>
      )}
      {session.phase === 'running' ? (
        <div className={styles.chatAuxiliary}>
          <div className={styles.runBanner} role="status">
            <Glyph className={`${styles.glyph} ${styles.bannerIcon}`} name="info" />
            <p>当前 Session 正在运行。</p>
            {capabilities.canCancelTurn ? (
              confirmStop ? (
                <button
                  className={styles.stopButton}
                  onClick={() => {
                    onCancel();
                    setConfirmStop(false);
                  }}
                  type="button"
                >
                  <Glyph name="stop" />
                  {`确认停止 ${session.shortId}`}
                </button>
              ) : (
                <button
                  className={styles.stopButton}
                  onClick={() => {
                    setConfirmStop(true);
                  }}
                  type="button"
                >
                  <Glyph name="stop" />
                  停止
                </button>
              )
            ) : null}
          </div>
        </div>
      ) : null}
      <div className={styles.toastLayer}>
        {hasNewContent ? (
          <button
            className={styles.newContent}
            onClick={() => {
              setFollowTail(true);
              const node = scrollRef.current;
              if (node !== null) {
                node.scrollTop = node.scrollHeight;
              }
              setHasNewContent(false);
            }}
            type="button"
          >
            回到最新
          </button>
        ) : null}
      </div>
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitEnabled) {
            return;
          }
          onSubmit();
        }}
      >
        <div className={styles.composerCard} data-testid="composer-card">
          <label className={styles.field}>
            <span className={styles.srOnly}>输入</span>
            <textarea
              disabled={!capabilities.canSubmitTurn}
              onChange={(event) => {
                onComposerText(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!submitEnabled) {
                    return;
                  }
                  onSubmit();
                }
              }}
              placeholder="描述目标或下一步。Enter 发送，Shift+Enter 换行。"
              value={composerText}
            />
          </label>
          {blockedMessage === undefined ? null : (
            <p className={styles.blockReason}>{blockedMessage}</p>
          )}
          <div className={styles.composerControls}>
            <label className={styles.field}>
              模型
              <select
                disabled={!capabilities.canChangeRuntime || !wired}
                onChange={(event) => {
                  actions?.changeRuntime({ model: event.target.value });
                }}
                value={session.model}
              >
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              安全模式
              <select
                disabled={!capabilities.canChangeRuntime || !wired}
                onChange={(event) => {
                  const mode = SAFETY_MODES.find((item) => item === event.target.value);
                  if (mode === 'full-access') {
                    setConfirmFullAccess(true);
                    return;
                  }
                  if (mode !== undefined) {
                    actions?.changeRuntime({ safetyMode: mode });
                  }
                }}
                ref={safetySelectRef}
                value={session.safetyMode}
              >
                {SAFETY_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
            <p className={styles.contextUsage} data-testid="context-usage">
              {contextLabel}
            </p>
            <button className={styles.sendButton} disabled={!submitEnabled} type="submit">
              发送
              <Glyph name="send" />
            </button>
          </div>
        </div>
      </form>
      <div aria-live="polite" className={styles.live}>
        {liveAnnouncement(turns, pending !== undefined)}
      </div>
      {confirmFullAccess ? (
        <FullAccessDialog
          onCancel={() => {
            setConfirmFullAccess(false);
          }}
          onConfirm={() => {
            setConfirmFullAccess(false);
            actions?.changeRuntime({
              safetyMode: 'full-access',
              fullAccessConfirmation: { acceptedRisk: true },
            });
          }}
          returnFocusTo={safetySelectRef.current}
        />
      ) : null}
    </>
  );
}
