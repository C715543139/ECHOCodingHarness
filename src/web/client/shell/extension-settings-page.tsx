import { useEffect, useId, useRef, useState, type RefObject } from 'react';

import type { WebConsoleActions, WebConsoleView } from '../view-model/console-controller.js';
import styles from './shell.module.css';

function UninstallDialog({
  extensionId,
  onCancel,
  onConfirm,
  returnFocusTo,
}: {
  readonly extensionId: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly returnFocusTo: HTMLElement | null;
}) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    return () => {
      returnFocusTo?.focus();
    };
  }, [returnFocusTo]);

  return (
    <div className={styles.overlay}>
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.confirmDialog}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key === 'Tab') {
            const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button');
            const first = buttons?.item(0);
            const last = buttons?.item((buttons?.length ?? 1) - 1);
            if (
              event.shiftKey &&
              (document.activeElement === titleRef.current || document.activeElement === first)
            ) {
              event.preventDefault();
              event.stopPropagation();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              event.stopPropagation();
              first?.focus();
            }
          }
        }}
        role="dialog"
      >
        <h2 id={titleId} ref={titleRef} tabIndex={-1}>
          {`确认卸载 ${extensionId}`}
        </h2>
        <p>卸载会停用该扩展并删除当前工作区中的安装版本与 staging 内容，此操作无法从 Web 撤销。</p>
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} onClick={onCancel} type="button">
            取消卸载
          </button>
          <button className={styles.dangerButton} onClick={onConfirm} type="button">
            {`确认卸载 ${extensionId}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ExtensionSettingsPage({
  actions,
  headingRef,
  onClose,
  titleId,
  view,
}: {
  readonly actions?: WebConsoleActions;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onClose: () => void;
  readonly titleId: string;
  readonly view: WebConsoleView;
}) {
  const [uninstall, setUninstall] = useState<{
    readonly id: string;
    readonly returnFocusTo: HTMLButtonElement;
  }>();

  return (
    <div className={styles.settingsBody}>
      <div className={styles.settingsHeader}>
        <div>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            扩展
          </h2>
          <p className={styles.settingsCaption}>
            仅显示当前工作区的已安装扩展。管理操作不受当前 Session 安全模式限制。
          </p>
        </div>
        <button
          className={styles.secondaryButton}
          disabled={view.extensionsLoading || actions === undefined}
          onClick={() => {
            actions?.refreshExtensions();
          }}
          type="button"
        >
          刷新
        </button>
      </div>
      {view.extensionError === undefined ? null : (
        <p className={styles.errorSummary} role="alert">
          {view.extensionError}
        </p>
      )}
      {view.extensionNotice === undefined ? null : (
        <p className={styles.extensionNotice} role="status">
          {view.extensionNotice}
        </p>
      )}
      {view.extensionsLoading ? <p>正在加载扩展…</p> : null}
      {!view.extensionsLoading && view.extensions.length === 0 ? (
        <p className={styles.muted}>当前工作区没有已安装扩展。</p>
      ) : null}
      <div className={styles.extensionList}>
        {view.extensions.map((extension) => {
          const pending = view.extensionPendingId === extension.id;
          return (
            <article className={styles.extensionCard} key={extension.id}>
              <div className={styles.extensionHeader}>
                <h3>{extension.id}</h3>
                <span>{extension.version}</span>
              </div>
              <dl className={styles.extensionFacts}>
                <div>
                  <dt>哈希</dt>
                  <dd>{extension.contentHash}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{extension.state}</dd>
                </div>
                <div>
                  <dt>加载状态</dt>
                  <dd>{extension.loaded ? '已加载' : '未加载'}</dd>
                </div>
                <div>
                  <dt>工具</dt>
                  <dd>{extension.tools.join('、')}</dd>
                </div>
              </dl>
              {extension.quarantineReason === undefined ? null : (
                <p className={styles.extensionWarning}>{extension.quarantineReason}</p>
              )}
              {extension.cleanupPending === true ? (
                <p className={styles.extensionWarning}>需要清理</p>
              ) : null}
              <div className={styles.actions}>
                {extension.state === 'enabled' ? (
                  <button
                    className={styles.secondaryButton}
                    disabled={pending || actions === undefined}
                    onClick={() => {
                      actions?.disableExtension(extension.id);
                    }}
                    type="button"
                  >
                    {`禁用 ${extension.id}`}
                  </button>
                ) : (
                  <button
                    className={styles.secondaryButton}
                    disabled={pending || actions === undefined}
                    onClick={() => {
                      actions?.enableExtension(extension.id);
                    }}
                    type="button"
                  >
                    {`启用 ${extension.id}`}
                  </button>
                )}
                <button
                  className={styles.dangerButton}
                  disabled={pending || actions === undefined}
                  onClick={(event) => {
                    setUninstall({ id: extension.id, returnFocusTo: event.currentTarget });
                  }}
                  type="button"
                >
                  {`卸载 ${extension.id}`}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <div className={styles.settingsFooter}>
        <button className={styles.secondaryButton} onClick={onClose} type="button">
          关闭
        </button>
      </div>
      {uninstall === undefined ? null : (
        <UninstallDialog
          extensionId={uninstall.id}
          onCancel={() => {
            setUninstall(undefined);
          }}
          onConfirm={() => {
            actions?.uninstallExtension(uninstall.id);
            setUninstall(undefined);
          }}
          returnFocusTo={uninstall.returnFocusTo}
        />
      )}
    </div>
  );
}
