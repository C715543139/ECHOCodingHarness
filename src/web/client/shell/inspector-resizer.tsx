import { useEffect, useRef } from 'react';

import styles from './shell.module.css';

export const INSPECTOR_MIN_WIDTH = 256;
export const INSPECTOR_MAX_WIDTH = 480;
export const INSPECTOR_DEFAULT_WIDTH = 304;
const KEYBOARD_STEP = 16;

export function clampInspectorWidth(width: number): number {
  if (!Number.isFinite(width)) return INSPECTOR_DEFAULT_WIDTH;
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(width)));
}

export function InspectorResizer({
  width,
  onWidth,
}: {
  readonly width: number;
  readonly onWidth: (width: number) => void;
}) {
  const dragging = useRef(false);

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      if (!dragging.current) return;
      event.preventDefault();
      onWidth(clampInspectorWidth(window.innerWidth - event.clientX));
    };
    const stop = (): void => {
      dragging.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [onWidth]);

  return (
    <div
      aria-label="调整 Inspector 宽度"
      aria-orientation="vertical"
      aria-valuemax={INSPECTOR_MAX_WIDTH}
      aria-valuemin={INSPECTOR_MIN_WIDTH}
      aria-valuenow={width}
      className={styles.inspectorResizer}
      data-testid="inspector-resizer"
      onDoubleClick={() => {
        onWidth(INSPECTOR_DEFAULT_WIDTH);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onWidth(clampInspectorWidth(width + KEYBOARD_STEP));
          return;
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          onWidth(clampInspectorWidth(width - KEYBOARD_STEP));
          return;
        }
        if (event.key === 'Home') {
          event.preventDefault();
          onWidth(INSPECTOR_MIN_WIDTH);
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          onWidth(INSPECTOR_MAX_WIDTH);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      role="separator"
      tabIndex={0}
    />
  );
}
