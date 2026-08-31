import { useEffect, useId, useRef } from 'react';

import type { SessionSummaryDto } from '../../../contracts/web.js';
import styles from './shell.module.css';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DeleteSessionDialog({
  session,
  active,
  pending,
  error,
  returnFocusTo,
  onCancel,
  onConfirm,
}: {
  readonly session: SessionSummaryDto;
  readonly active: boolean;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly returnFocusTo: HTMLElement | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const previouslyFocused = returnFocusTo;
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [returnFocusTo]);

  return (
    <div className={styles.overlay}>
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.confirmDialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!pending) onCancel();
            return;
          }
          if (event.key !== 'Tab' || dialogRef.current === null) return;
          const nodes = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
          const first = nodes[0];
          const last = nodes.at(-1);
          if (first === undefined || last === undefined) {
            event.preventDefault();
            return;
          }
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === headingRef.current)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          删除会话？
        </h2>
        <p className={styles.confirmSessionTitle}>{session.title}</p>
        <p id={descriptionId}>
          {active
            ? '当前会话仍在运行。确认后将先停止当前 Turn，等待结束，再永久删除会话。'
            : '删除后将永久移除该会话记录，无法恢复。'}
        </p>
        {error === undefined ? null : <p className={styles.errorSummary}>{error}</p>}
        <div className={styles.dialogActions}>
          <button
            className={styles.secondaryButton}
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className={styles.dangerButton}
            disabled={pending}
            onClick={onConfirm}
            type="button"
          >
            {pending
              ? active
                ? '正在停止并删除…'
                : '正在删除…'
              : active
                ? '停止并删除'
                : '删除会话'}
          </button>
        </div>
      </div>
    </div>
  );
}
