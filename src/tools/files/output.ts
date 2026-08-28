export interface LimitedRecords<T> {
  readonly records: readonly T[];
  readonly omitted: number;
}

export function limitRecordsHeadTail<T>(
  records: readonly T[],
  maximumRecords: number,
  maximumCharacters: number,
): LimitedRecords<T> {
  const recordLimit = Math.max(0, Math.floor(maximumRecords));
  const characterLimit = Math.max(0, Math.floor(maximumCharacters));
  let retained = selectHeadTail(records, Math.min(records.length, recordLimit));

  while (retained.length > 0 && JSON.stringify(retained).length > characterLimit) {
    if (retained.length <= 2) {
      if (retained.length === 2) {
        retained = [retained[0] as T];
      } else {
        retained = [];
      }
      continue;
    }
    retained = [
      ...retained.slice(0, Math.ceil((retained.length - 1) / 2)),
      ...retained.slice(-Math.floor((retained.length - 1) / 2)),
    ];
  }

  return { records: retained, omitted: records.length - retained.length };
}

function selectHeadTail<T>(records: readonly T[], count: number): T[] {
  if (count >= records.length) {
    return [...records];
  }
  if (count <= 0) {
    return [];
  }
  const headCount = Math.ceil(count / 2);
  const tailCount = Math.floor(count / 2);
  return [...records.slice(0, headCount), ...records.slice(records.length - tailCount)];
}
