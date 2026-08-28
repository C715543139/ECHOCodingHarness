export interface TestReport {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
}

function matchCount(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  if (match?.[1] === undefined) {
    return 0;
  }
  return Number(match[1]);
}

export function parseReport(text: string): TestReport {
  const passed = matchCount(text, /(\d+)\s+passed/iu);
  const failed = matchCount(text, /(\d+)\s+failed/iu);
  return {
    passed,
    failed,
    total: passed,
  };
}
