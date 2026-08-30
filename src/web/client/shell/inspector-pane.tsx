import { useEffect, useRef, useState } from 'react';

import type { TraceRecordDetailDto } from '../../../contracts/web.js';
import { Glyph } from './glyph.js';
import styles from './shell.module.css';

const COLLAPSE_AFTER = 400;

export function InspectorPane({
  detail,
  onClose,
}: {
  readonly detail: TraceRecordDetailDto;
  readonly onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [detail.id]);

  return (
    <aside aria-labelledby="inspector-title" className={styles.inspector} role="complementary">
      <div className={styles.inspectorHeader}>
        <h2 id="inspector-title" ref={headingRef} tabIndex={-1}>
          Inspector
        </h2>
        <button
          aria-label="关闭"
          className={styles.iconButton}
          onClick={onClose}
          title="关闭"
          type="button"
        >
          <Glyph name="close" />
        </button>
      </div>
      <p className={styles.inspectorIdentity}>
        {detail.label} · {detail.type} · {detail.status}
      </p>
      {detail.sections.map((section) => (
        <section className={styles.inspectorSection} key={`${detail.id}:${section.key}`}>
          <h3>{section.title}</h3>
          {(section.fields ?? []).map((field) => (
            <p className={styles.inspectorField} key={field.label}>
              <span className={styles.inspectorLabel}>{field.label}：</span>
              <span className={styles.inspectorFieldValue}>{field.value}</span>
            </p>
          ))}
          {section.code === undefined ? null : (
            <BoundedBlock
              label={`${section.title} code`}
              text={section.code.text}
              truncated={section.code.truncated}
            />
          )}
          {section.diff === undefined ? null : (
            <div>
              <p className={styles.inspectorField}>
                <span className={styles.inspectorLabel}>路径：</span>
                <span className={styles.inspectorFieldValue}>{section.diff.path}</span>
              </p>
              <BoundedBlock
                label={`${section.title} diff`}
                text={section.diff.text}
                truncated={section.diff.truncated}
              />
            </div>
          )}
        </section>
      ))}
      {detail.relatedRecordIds.length === 0 ? null : (
        <section className={styles.inspectorSection}>
          <h3>关联</h3>
          <ul className={styles.relatedList}>
            {detail.relatedRecordIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function BoundedBlock({
  label,
  text,
  truncated,
}: {
  readonly label: string;
  readonly text: string;
  readonly truncated: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const collapsed = text.length > COLLAPSE_AFTER;

  return (
    <div className={styles.boundedBlock}>
      <div className={styles.boundedActions}>
        <button
          className={styles.secondaryButton}
          onClick={() => {
            const clipboard = navigator.clipboard;
            if (clipboard === undefined) return;
            void clipboard.writeText(text).then(() => {
              setCopied(true);
            });
          }}
          type="button"
        >
          {copied ? '已复制' : '复制'}
        </button>
        {truncated ? <span className={styles.truncated}>truncated</span> : null}
      </div>
      {collapsed ? (
        <details>
          <summary>{label}</summary>
          <pre>
            <code>{text}</code>
          </pre>
        </details>
      ) : (
        <pre>
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}
