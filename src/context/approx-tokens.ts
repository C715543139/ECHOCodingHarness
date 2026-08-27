export function approxTokensForText(text: string): number {
  return Math.ceil(text.length / 4);
}

export function approxTokensForValue(value: unknown): number {
  return approxTokensForText(safeJsonStringify(value));
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}

export function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.round(value), min), max);
}
