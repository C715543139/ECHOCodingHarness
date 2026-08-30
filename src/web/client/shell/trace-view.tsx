import type { TraceRecordDto } from '../../../contracts/web.js';
import styles from './shell.module.css';

export function TraceView({
  records,
  selectedRecordId,
  onSelectRecord,
}: {
  readonly records: readonly TraceRecordDto[];
  readonly selectedRecordId: string | undefined;
  readonly onSelectRecord: (id: string) => void;
}) {
  if (records.length === 0) {
    return (
      <div className={styles.scroll}>
        <p>暂无 Trace 记录。业务事件按时间顺序投影，不显示 chunk 或 reasoning。</p>
      </div>
    );
  }

  return (
    <div className={styles.scroll} role="list">
      {records.map((record) => (
        <button
          aria-current={record.id === selectedRecordId}
          aria-label={`${record.label} ${record.type} ${record.status}`}
          className={styles.traceButton}
          key={record.id}
          onClick={() => {
            onSelectRecord(record.id);
          }}
          type="button"
        >
          <strong>
            {record.time.slice(11, 19)} · {record.type} · {record.label}
          </strong>
          <span className={styles.sessionMeta}>
            {record.status}
            {record.parameterSummary === undefined ? '' : ` · ${record.parameterSummary}`}
          </span>
        </button>
      ))}
    </div>
  );
}
