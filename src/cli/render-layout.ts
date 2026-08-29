import type { RenderCapabilities, RenderChunk } from '../contracts/index.js';

import { visibleWidth, wrapToWidth } from './render-width.js';

export const LABEL_COLUMN = 10;
export const STACKED_COLUMNS = 40;
export const DEFAULT_COLUMNS = 80;

export const COLORS = {
  blue: '\u001B[34m',
  blueBold: '\u001B[1;34m',
  cyan: '\u001B[36m',
  dim: '\u001B[2m',
  green: '\u001B[32m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
  reset: '\u001B[0m',
} as const;

export type LabelColor = Exclude<keyof typeof COLORS, 'reset'>;

export interface LayoutOptions {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly columns: number;
}

export function resolveColumns(capabilities: RenderCapabilities): number {
  const columns = capabilities.columns;
  if (typeof columns === 'number' && Number.isFinite(columns) && columns >= 1) {
    return Math.floor(columns);
  }
  return DEFAULT_COLUMNS;
}

export function layoutOptions(capabilities: RenderCapabilities): LayoutOptions {
  return {
    color: capabilities.color,
    unicode: capabilities.unicode,
    columns: resolveColumns(capabilities),
  };
}

export function columnSeparator(unicode: boolean): string {
  return unicode ? '│' : '|';
}

export function ruleFill(unicode: boolean): string {
  return unicode ? '─' : '-';
}

export function promptMarker(unicode: boolean): string {
  return unicode ? '›' : '>';
}

export function valueJoin(unicode: boolean): string {
  return unicode ? ' · ' : ' | ';
}

export function colorize(text: string, color: LabelColor | undefined, enabled: boolean): string {
  if (!enabled || color === undefined || text.length === 0) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

export function padLabel(label: string): string {
  return label.length >= LABEL_COLUMN ? label : label.padEnd(LABEL_COLUMN, ' ');
}

export function shouldStack(columns: number): boolean {
  return columns < STACKED_COLUMNS;
}

function labelPrefix(label: string, unicode: boolean): string {
  return `${padLabel(label)} ${columnSeparator(unicode)} `;
}

function hangingPrefix(label: string, unicode: boolean): string {
  return `${' '.repeat(padLabel(label).length)} ${columnSeparator(unicode)} `;
}

function bodyWidthFor(prefix: string, columns: number): number {
  return Math.max(8, columns - visibleWidth(prefix));
}

export function formatLabeled(
  label: string,
  body: string,
  options: LayoutOptions,
  color?: LabelColor,
): readonly string[] {
  if (body.length === 0) return [colorize(label, color, options.color)];
  if (shouldStack(options.columns)) {
    const heading = colorize(label, color, options.color);
    const indent = '    ';
    const wrapped = wrapToWidth(body, Math.max(8, options.columns - indent.length));
    return [heading, ...wrapped.map((line) => `${indent}${line}`)];
  }

  const plainPrefix = labelPrefix(label, options.unicode);
  const hang = hangingPrefix(label, options.unicode);
  const wrapped = wrapToWidth(body, bodyWidthFor(plainPrefix, options.columns));
  const coloredPrefix = `${colorize(padLabel(label), color, options.color)} ${columnSeparator(options.unicode)} `;
  return wrapped.map((line, index) => `${index === 0 ? coloredPrefix : hang}${line}`);
}

export function formatLabeledBlock(
  label: string,
  lines: readonly string[],
  options: LayoutOptions,
  color?: LabelColor,
): readonly string[] {
  if (lines.length === 0) return formatLabeled(label, '', options, color);
  const [first, ...rest] = lines;
  const output = [...formatLabeled(label, first ?? '', options, color)];
  for (const extra of rest) {
    if (shouldStack(options.columns)) {
      const indent = '    ';
      output.push(
        ...wrapToWidth(extra, Math.max(8, options.columns - indent.length)).map(
          (line) => `${indent}${line}`,
        ),
      );
      continue;
    }
    const hang = hangingPrefix(label, options.unicode);
    output.push(
      ...wrapToWidth(extra, bodyWidthFor(hang, options.columns)).map((line) => `${hang}${line}`),
    );
  }
  return output;
}

export function formatRuleTitle(title: string, options: LayoutOptions, color?: LabelColor): string {
  const fill = ruleFill(options.unicode);
  const start = options.unicode ? '──' : '--';
  const core = `${start} ${title} `;
  const width = Math.max(visibleWidth(core) + 2, Math.min(options.columns, DEFAULT_COLUMNS));
  let line = core;
  while (visibleWidth(line) < width) line += fill;
  return colorize(line, color, options.color);
}

export function stderrLines(lines: readonly string[]): readonly RenderChunk[] {
  return lines.map((text) => ({ channel: 'stderr', text: `${text}\n` }));
}

export function stderrOpenLine(text: string): RenderChunk {
  return { channel: 'stderr', text };
}

export function colorStatus(status: string, enabled: boolean): string {
  if (status === 'OK' || status === 'APPROVED') return colorize(status, 'green', enabled);
  if (status === 'FAIL' || status === 'DENIED') return colorize(status, 'red', enabled);
  if (status === 'WARN' || status === 'LIMIT' || status === 'CANCELLED') {
    return colorize(status, 'yellow', enabled);
  }
  return status;
}
