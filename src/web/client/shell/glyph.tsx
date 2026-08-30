import styles from './shell.module.css';

const PATHS = {
  plus: 'M8 3.5v9M3.5 8h9',
  folder: 'M2 4.5A1 1 0 0 1 3 3.5h3l1.2 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z',
  gear: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1',
  chevronLeft: 'M9.5 4 6 8l3.5 4',
  chevronRight: 'M6.5 4 10 8l-3.5 4',
  info: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12M8 7.2v4M8 5.1v.1',
  stop: 'M4.5 4.5h7v7h-7z',
  send: 'M2.5 8 13.5 3l-4 5 4 5z',
  close: 'M4 4l8 8M12 4l-8 8',
  shield: 'M8 2.2 13 4v4c0 3-2.2 5.1-5 5.8-2.8-.7-5-2.8-5-5.8V4z',
  database:
    'M8 5.6c2.8 0 5-.8 5-1.8S10.8 2 8 2 3 2.8 3 3.8s2.2 1.8 5 1.8M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8',
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({
  name,
  className = styles.glyph,
}: {
  readonly name: GlyphName;
  readonly className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
