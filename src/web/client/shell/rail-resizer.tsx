import { useEffect, useRef } from 'react';

import styles from './shell.module.css';

export const RAIL_MIN_WIDTH = 208;
export const RAIL_MAX_WIDTH = 420;
export const RAIL_DEFAULT_WIDTH = 280;
const KEYBOARD_STEP = 16;

export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)));
}

export function RailResizer({
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
      onWidth(clampRailWidth(event.clientX));
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
      aria-label="调整会话栏宽度"
      aria-orientation="vertical"
      aria-valuemax={RAIL_MAX_WIDTH}
      aria-valuemin={RAIL_MIN_WIDTH}
      aria-valuenow={width}
      className={styles.railResizer}
      data-testid="rail-resizer"
      onDoubleClick={() => {
        onWidth(RAIL_DEFAULT_WIDTH);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onWidth(clampRailWidth(width - KEYBOARD_STEP));
          return;
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          onWidth(clampRailWidth(width + KEYBOARD_STEP));
          return;
        }
        if (event.key === 'Home') {
          event.preventDefault();
          onWidth(RAIL_MIN_WIDTH);
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          onWidth(RAIL_MAX_WIDTH);
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
