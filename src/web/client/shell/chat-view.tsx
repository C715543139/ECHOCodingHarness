import type {
  ChatTurnDto,
  RuntimeCapabilitiesDto,
  SessionRuntimeDto,
} from '../../../contracts/web.js';
import styles from './shell.module.css';

const SAFETY_MODES = ['safe', 'balanced', 'auto'] as const;

export function ChatView({
  session,
  turns,
  capabilities,
  composerText,
  onComposerText,
  onSubmit,
  onCancel,
}: {
  readonly session: SessionRuntimeDto | undefined;
  readonly turns: readonly ChatTurnDto[];
  readonly capabilities: RuntimeCapabilitiesDto;
  readonly composerText: string;
  readonly onComposerText: (text: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  if (session === undefined) {
    return (
      <div className={styles.scroll}>
        <p>选择或新建会话后开始对话。</p>
      </div>
    );
  }

  const contextLabel = `${String(session.context.usedApproxTokens)} / ${String(session.context.limitApproxTokens)}`;
  const blocked = capabilities.submitTurnBlockedReason;
  const blockedMessage =
    blocked === 'turn_active'
      ? '另一会话正在运行'
      : blocked === 'provider_unavailable'
        ? 'Provider 不可用或本地 API 不可达'
        : blocked === 'session_unavailable'
          ? '请选择或新建会话'
          : undefined;

  return (
    <>
      <div className={styles.scroll} data-testid="chat-scroll">
        {turns.length === 0 ? <p>开始对话。历史只投影聚合 Session 事实。</p> : null}
        {turns.map((turn) => (
          <article className={styles.turn} key={turn.turnId}>
            <h3>用户</h3>
            <p>{turn.userText}</p>
            {turn.responses.map((response) => (
              <p key={response.step}>{response.text}</p>
            ))}
            <p className={styles.muted}>
              {turn.status}
              {turn.stopReason === undefined ? '' : ` · ${turn.stopReason}`}
            </p>
          </article>
        ))}
      </div>
      {session.phase === 'running' ? (
        <div className={styles.runBanner} role="status">
          <p>当前 Session 正在运行。</p>
          {capabilities.canCancelTurn ? (
            <button className={styles.stopButton} onClick={onCancel} type="button">
              停止
            </button>
          ) : null}
        </div>
      ) : null}
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className={styles.runtimeRow}>
          <label className={styles.field}>
            模型
            <select
              disabled={!capabilities.canChangeRuntime}
              onChange={() => undefined}
              value={session.model}
            >
              <option value={session.model}>{session.model}</option>
            </select>
          </label>
          <label className={styles.field}>
            安全模式
            <select
              disabled={!capabilities.canChangeRuntime}
              onChange={() => undefined}
              value={session.safetyMode}
            >
              {SAFETY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <p className={styles.muted} data-testid="context-usage">
            {contextLabel}
          </p>
        </div>
        <label className={styles.field}>
          输入
          <textarea
            disabled={!capabilities.canSubmitTurn}
            onChange={(event) => {
              onComposerText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
            value={composerText}
          />
        </label>
        {blockedMessage === undefined ? null : (
          <p className={styles.blockReason}>{blockedMessage}</p>
        )}
        <div className={styles.actions}>
          <button
            className={styles.sendButton}
            disabled={!capabilities.canSubmitTurn || composerText.trim().length === 0}
            type="submit"
          >
            发送
          </button>
        </div>
      </form>
    </>
  );
}
