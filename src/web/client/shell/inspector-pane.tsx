import { useEffect, useRef } from 'react';

import type { TraceRecordDetailDto } from '../../../contracts/web.js';
import styles from './shell.module.css';

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
      <h2 id="inspector-title" ref={headingRef} tabIndex={-1}>
        Inspector
      </h2>
      <button className={styles.secondaryButton} onClick={onClose} type="button">
        关闭
      </button>
      {detail.sections.map((section) => (
        <section key={section.key}>
          <h3>{section.title}</h3>
          {(section.fields ?? []).map((field) => (
            <p key={field.label}>
              <span className={styles.muted}>{field.label}：</span>
              {field.value}
            </p>
          ))}
          {section.code === undefined ? null : (
            <pre>
              <code>{section.code.text}</code>
            </pre>
          )}
        </section>
      ))}
    </aside>
  );
}
