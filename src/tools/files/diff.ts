import { truncateHeadTail } from './text.js';

export interface DiffResult {
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
  readonly omittedChars: number;
}

export function createDiff(
  previousContent: string,
  nextContent: string,
  relativePath: string,
  maximumCharacters: number,
): DiffResult {
  if (previousContent === nextContent) {
    return { diff: '', additions: 0, deletions: 0, truncated: false, omittedChars: 0 };
  }

  const previousLines = diffLines(previousContent);
  const nextLines = diffLines(nextContent);
  let prefixLength = 0;
  while (
    prefixLength < previousLines.length &&
    prefixLength < nextLines.length &&
    previousLines[prefixLength] === nextLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previousLines.length - prefixLength &&
    suffixLength < nextLines.length - prefixLength &&
    previousLines[previousLines.length - 1 - suffixLength] ===
      nextLines[nextLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const previousChanged = previousLines.slice(prefixLength, previousLines.length - suffixLength);
  const nextChanged = nextLines.slice(prefixLength, nextLines.length - suffixLength);
  const contextStart = Math.max(0, prefixLength - 3);
  const contextEndPrevious = Math.min(
    previousLines.length,
    previousLines.length - suffixLength + 3,
  );
  const contextBefore = previousLines.slice(contextStart, prefixLength);
  const contextAfter = previousLines.slice(previousLines.length - suffixLength, contextEndPrevious);
  const hunkPreviousCount = contextBefore.length + previousChanged.length + contextAfter.length;
  const hunkNextCount = contextBefore.length + nextChanged.length + contextAfter.length;
  const rendered = [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${contextStart + 1},${hunkPreviousCount} +${contextStart + 1},${hunkNextCount} @@`,
    ...contextBefore.map((line) => ` ${line}`),
    ...previousChanged.map((line) => `-${line}`),
    ...nextChanged.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
    '',
  ].join('\n');
  const bounded = truncateHeadTail(rendered, maximumCharacters);
  return {
    diff: bounded.content,
    additions: nextChanged.length,
    deletions: previousChanged.length,
    truncated: bounded.truncated,
    omittedChars: bounded.omittedChars,
  };
}

function diffLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }
  const normalized = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}
