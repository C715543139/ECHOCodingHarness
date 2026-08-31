import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { TraceRecordDto } from '../../../contracts/web.js';
import {
  applyTraceUpserts,
  createTraceListState,
  pauseTraceFollow,
  resumeTraceFollow,
  visibleTraceRecords,
} from '../../trace/upsert.js';
import styles from './shell.module.css';

const VIRTUALIZE_AFTER = 40;
const ROW_HEIGHT = 72;
const OVERSCAN = 6;
const BOTTOM_TOLERANCE = 8;

export function TraceView({
  records,
  selectedRecordId,
  onSelectRecord,
  pageSize = 100,
}: {
  readonly records: readonly TraceRecordDto[];
  readonly selectedRecordId: string | undefined;
  readonly onSelectRecord: (id: string) => void;
  readonly pageSize?: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousRecords = useRef<readonly TraceRecordDto[]>([]);
  const [list, setList] = useState(() => createTraceListState(pageSize));
  const [windowStart, setWindowStart] = useState(0);

  useEffect(() => {
    const previous = previousRecords.current;
    previousRecords.current = records;
    const incoming = records.filter((record) => {
      const prior = previous.find((item) => item.id === record.id);
      return prior === undefined || record.seq > prior.seq;
    });
    const overlap = previous.some((record) => records.some((item) => item.id === record.id));
    const disjoint = previous.length > 0 && !overlap;
    if (disjoint) {
      setWindowStart(0);
      const viewport = viewportRef.current;
      if (viewport !== null) viewport.scrollTop = 0;
    }
    setList((current) => {
      const base = disjoint ? createTraceListState(pageSize) : { ...current, pageSize };
      return incoming.length === 0 ? base : applyTraceUpserts(base, incoming);
    });
  }, [pageSize, records]);

  const visible = useMemo(() => visibleTraceRecords(list), [list]);
  const virtualized = visible.length > VIRTUALIZE_AFTER;
  const maxStart = Math.max(0, visible.length - 1);
  const clampedStart = Math.min(windowStart, maxStart);
  const windowCount = virtualized
    ? Math.min(visible.length, clampedStart + Math.ceil(480 / ROW_HEIGHT) + OVERSCAN * 2)
    : visible.length;
  const rendered = virtualized ? visible.slice(clampedStart, windowCount) : visible;
  const tailWindowStart = virtualized
    ? Math.max(0, visible.length - Math.ceil(480 / ROW_HEIGHT) - OVERSCAN * 2)
    : 0;
  const lastVisibleSeq = visible.at(-1)?.seq;

  useEffect(() => {
    if (windowStart === clampedStart) return;
    setWindowStart(clampedStart);
  }, [clampedStart, windowStart]);

  useLayoutEffect(() => {
    if (!list.followTail) return;
    if (windowStart !== tailWindowStart) {
      setWindowStart(tailWindowStart);
      return;
    }
    const viewport = viewportRef.current;
    if (viewport !== null) viewport.scrollTop = viewport.scrollHeight;
  }, [lastVisibleSeq, list.followTail, tailWindowStart, windowStart]);

  if (records.length === 0) {
    return (
      <div className={styles.scroll}>
        <p>暂无 Trace 记录。业务事件按时间顺序投影，不显示 chunk 或 reasoning。</p>
      </div>
    );
  }

  return (
    <div className={styles.tracePane}>
      <div aria-hidden="true" className={styles.traceColumns}>
        <span>时间</span>
        <span>事件</span>
        <span>状态</span>
      </div>
      <div
        className={styles.scroll}
        onScroll={(event) => {
          const target = event.currentTarget;
          const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
          const atBottom = target.clientHeight > 0 && distance <= BOTTOM_TOLERANCE;
          if (!atBottom) {
            setList((current) => (current.followTail ? pauseTraceFollow(current) : current));
          } else if (!list.followTail) {
            setList((current) => resumeTraceFollow(current));
          }
          if (virtualized) {
            const start = Math.max(0, Math.floor(target.scrollTop / ROW_HEIGHT) - OVERSCAN);
            setWindowStart(start);
          }
        }}
        ref={viewportRef}
        role="list"
      >
        {virtualized ? (
          <div
            className={styles.traceVirtual}
            style={{ height: `${String(visible.length * ROW_HEIGHT)}px` }}
          >
            {rendered.map((record, offset) => {
              const index = clampedStart + offset;
              return (
                <div
                  className={styles.traceVirtualRow}
                  key={record.id}
                  style={{
                    top: `${String(index * ROW_HEIGHT)}px`,
                    height: `${String(ROW_HEIGHT)}px`,
                  }}
                >
                  <TraceRow
                    index={index}
                    previousTurnId={index === 0 ? undefined : visible[index - 1]?.turnId}
                    record={record}
                    selected={record.id === selectedRecordId}
                    total={visible.length}
                    onSelect={onSelectRecord}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          visible.map((record, index) => (
            <TraceRow
              index={index}
              key={record.id}
              previousTurnId={index === 0 ? undefined : visible[index - 1]?.turnId}
              record={record}
              selected={record.id === selectedRecordId}
              total={visible.length}
              onSelect={onSelectRecord}
            />
          ))
        )}
      </div>
      <div className={styles.toastLayer}>
        {list.followTail ? null : (
          <button
            className={styles.newEvents}
            onClick={() => {
              setList((current) => resumeTraceFollow(current));
              const viewport = viewportRef.current;
              if (viewport !== null) {
                viewport.scrollTop = viewport.scrollHeight;
              }
            }}
            type="button"
          >
            回到最新
          </button>
        )}
      </div>
    </div>
  );
}

function TraceRow({
  index,
  record,
  selected,
  total,
  previousTurnId,
  onSelect,
}: {
  readonly index: number;
  readonly record: TraceRecordDto;
  readonly selected: boolean;
  readonly total: number;
  readonly previousTurnId: string | undefined;
  readonly onSelect: (id: string) => void;
}) {
  const grouped = previousTurnId !== record.turnId;
  return (
    <div aria-posinset={index + 1} aria-setsize={total} className={styles.traceRow} role="listitem">
      {grouped ? <p className={styles.traceGroup}>Turn {record.turnId}</p> : null}
      <button
        aria-current={selected}
        aria-label={`${record.label} ${record.type} ${record.status}`}
        className={styles.traceButton}
        data-seq={String(record.seq)}
        onClick={() => {
          onSelect(record.id);
        }}
        type="button"
      >
        <span className={styles.traceTime}>{record.time.slice(11, 19)}</span>
        <span className={styles.traceLabel}>
          <span className={styles.traceKind}>{record.type}</span>
          {record.label}
        </span>
        <span className={styles.traceStatus}>
          {record.status}
          {record.durationMs === undefined ? '' : ` · ${String(record.durationMs)} ms`}
        </span>
        <span className={styles.traceResult}>
          {record.parameterSummary ?? ''}
          {record.resultSummary === undefined
            ? ''
            : `${record.parameterSummary === undefined ? '' : ' · '}${record.resultSummary}`}
        </span>
      </button>
    </div>
  );
}
