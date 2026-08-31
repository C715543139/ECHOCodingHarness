import { useEffect, useId, useRef } from 'react';

import styles from './shell.module.css';

export function FullAccessDialog({
  onCancel,
  onConfirm,
  returnFocusTo,
}: {
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
          确认启用 Full Access
        </h2>
        <p>
          Full Access 允许模型命令访问网络、安装依赖、执行 Git
          写操作、删除文件，并可能访问工作区外位置。
        </p>
        <p>
          模型可以执行任意命令，这不是操作系统沙箱；超时、取消、输出限制、事件记录和凭据隔离仍然生效。
        </p>
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} onClick={onCancel} type="button">
            取消
          </button>
          <button className={styles.dangerButton} onClick={onConfirm} type="button">
            确认启用 Full Access
          </button>
        </div>
      </div>
    </div>
  );
}
