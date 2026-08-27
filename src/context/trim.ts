export interface TrimResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalSize: number;
  readonly keptSize: number;
}

export interface TrimOptions {
  readonly headChars: number;
  readonly tailChars: number;
}

export function trimHeadTail(text: string, options: TrimOptions): TrimResult {
  const originalSize = text.length;
  if (originalSize <= options.headChars + options.tailChars) {
    return { text, truncated: false, originalSize, keptSize: originalSize };
  }
  const head = text.slice(0, options.headChars);
  const tail = text.slice(originalSize - options.tailChars);
  const marker = `\n[... truncated ${originalSize - options.headChars - options.tailChars} characters ...]\n`;
  const combined = `${head}${marker}${tail}`;
  return { text: combined, truncated: true, originalSize, keptSize: combined.length };
}

export function truncateToLimit(text: string, maxChars: number): TrimResult {
  const originalSize = text.length;
  if (originalSize <= maxChars) {
    return { text, truncated: false, originalSize, keptSize: originalSize };
  }
  const marker = `\n[... truncated ${originalSize - maxChars} characters ...]`;
  const kept = `${text.slice(0, maxChars)}${marker}`;
  return { text: kept, truncated: true, originalSize, keptSize: kept.length };
}
