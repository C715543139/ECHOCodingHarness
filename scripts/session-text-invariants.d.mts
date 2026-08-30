export function assertAggregatedSessionText(
  events: readonly unknown[],
  extras?: Readonly<{
    textLineCount?: number;
    textLineBytes?: number;
    lineCount?: number;
  }>,
): {
  readonly modelResponses: number;
  readonly textEvents: number;
  readonly textChars: number;
  readonly textLineCount: number;
  readonly textLineBytes: number | undefined;
  readonly lineCount: number;
};

export function assertAggregatedSessionJsonl(jsonlText: string): {
  readonly modelResponses: number;
  readonly textEvents: number;
  readonly textChars: number;
  readonly textLineCount: number;
  readonly textLineBytes: number;
  readonly lineCount: number;
};
