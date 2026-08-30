import type { ApprovalChoiceDto, ApprovalRequestDto } from '../../../contracts/web.js';
import { APPROVAL_CHOICE_LABELS } from './labels.js';
import styles from './shell.module.css';

const KEY_TO_CHOICE: Readonly<Record<string, ApprovalChoiceDto>> = {
  n: 'deny',
  y: 'allow_once',
  s: 'allow_session',
};

export function ApprovalCard({
  approval,
  disabled,
  errorMessage,
  onDecide,
}: {
  readonly approval: ApprovalRequestDto;
  readonly disabled: boolean;
  readonly errorMessage: string | undefined;
  readonly onDecide: (decision: ApprovalChoiceDto) => void;
}) {
  return (
    <section
      aria-label="审批"
      className={styles.approvalCard}
      data-testid="approval-card"
      onKeyDown={(event) => {
        if (disabled) {
          return;
        }
        const decision = KEY_TO_CHOICE[event.key.toLowerCase()];
        if (decision === undefined) {
          return;
        }
        event.preventDefault();
        onDecide(decision);
      }}
      tabIndex={0}
    >
      <h3>等待审批</h3>
      <p>
        {approval.toolName} · {approval.actionSummary}
      </p>
      <p className={styles.muted}>{approval.riskReason}</p>
      <p className={styles.muted}>作用域：当前 Session / Turn</p>
      {errorMessage === undefined ? null : <p className={styles.blockReason}>{errorMessage}</p>}
      <div className={styles.actions}>
        <button
          aria-keyshortcuts="n"
          className={styles.choiceButton}
          disabled={disabled}
          onClick={() => {
            onDecide('deny');
          }}
          type="button"
        >
          {APPROVAL_CHOICE_LABELS.deny}
        </button>
        <button
          aria-keyshortcuts="y"
          className={styles.choiceButton}
          disabled={disabled}
          onClick={() => {
            onDecide('allow_once');
          }}
          type="button"
        >
          {APPROVAL_CHOICE_LABELS.allow_once}
        </button>
        <button
          aria-keyshortcuts="s"
          className={styles.choiceButton}
          disabled={disabled}
          onClick={() => {
            onDecide('allow_session');
          }}
          type="button"
        >
          {APPROVAL_CHOICE_LABELS.allow_session}
        </button>
      </div>
    </section>
  );
}
