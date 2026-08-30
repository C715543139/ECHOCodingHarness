import { useEffect, useId, useRef } from 'react';

import type { ProviderConfigDto } from '../../../contracts/web.js';
import styles from './shell.module.css';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.tabIndex !== -1,
  );
}

export function SettingsModal({
  provider,
  onChange,
  onClose,
  onSave,
  returnFocusTo,
}: {
  readonly provider: ProviderConfigDto;
  readonly onChange: (draft: ProviderConfigDto) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly returnFocusTo: HTMLElement | null;
}) {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const readOnly = !provider.writable;
  const catalogSource = provider.catalog.source;
  const models =
    provider.catalog.source === 'manual' ? provider.catalog.models : provider.catalog.cachedModels;

  useEffect(() => {
    headingRef.current?.focus();
    const previouslyFocused = returnFocusTo;

    return () => {
      previouslyFocused?.focus();
    };
  }, [returnFocusTo]);

  return (
    <div className={styles.overlay}>
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== 'Tab' || dialogRef.current === null) {
            return;
          }
          const nodes = focusableElements(dialogRef.current);
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          if (first === undefined || last === undefined) {
            event.preventDefault();
            return;
          }
          const active = document.activeElement;
          if (event.shiftKey && (active === first || active === headingRef.current)) {
            event.preventDefault();
            last.focus();
            return;
          }
          if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <nav aria-label="设置" className={styles.settingsNav}>
          <p aria-current="page">Provider</p>
        </nav>
        <div className={styles.settingsBody}>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            Provider
          </h2>
          {readOnly ? <p className={styles.errorSummary}>活动 Turn 存在时设置只读。</p> : null}
          <label className={styles.field}>
            Base URL
            <input
              onChange={(event) => {
                onChange({ ...provider, baseUrl: event.target.value });
              }}
              readOnly={readOnly}
              value={provider.baseUrl}
            />
          </label>
          <fieldset className={styles.field}>
            <legend>模型目录模式</legend>
            <label>
              <input
                checked={catalogSource === 'discover'}
                disabled={readOnly}
                name="catalog-source"
                onChange={() => {
                  onChange({
                    ...provider,
                    catalog: { source: 'discover', cachedModels: models },
                  });
                }}
                type="radio"
              />
              自动发现
            </label>
            <label>
              <input
                checked={catalogSource === 'manual'}
                disabled={readOnly}
                name="catalog-source"
                onChange={() => {
                  onChange({
                    ...provider,
                    catalog: { source: 'manual', models },
                  });
                }}
                type="radio"
              />
              手动维护
            </label>
          </fieldset>
          {catalogSource === 'discover' ? (
            <div>
              <button className={styles.secondaryButton} disabled={readOnly} type="button">
                获取模型
              </button>
              <ul>
                {models.map((model) => (
                  <li key={model}>{model}</li>
                ))}
              </ul>
            </div>
          ) : (
            <ul>
              {models.map((model) => (
                <li key={model}>{model}</li>
              ))}
            </ul>
          )}
          <label className={styles.field}>
            默认模型
            <select
              disabled={readOnly}
              onChange={(event) => {
                onChange({ ...provider, defaultModel: event.target.value });
              }}
              value={provider.defaultModel}
            >
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <p data-testid="api-key-status">
            {provider.apiKeyConfigured ? '已通过环境变量配置' : '未配置'}
          </p>
          <div className={styles.actions}>
            <button className={styles.secondaryButton} onClick={onClose} type="button">
              取消
            </button>
            <button
              className={styles.sendButton}
              disabled={readOnly}
              onClick={onSave}
              type="button"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
