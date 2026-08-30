import { expect } from 'vitest';

import type { TraceRecordDetailDto, TraceRecordDto } from '../../../src/contracts/web.js';

export function fieldValue(detail: TraceRecordDetailDto, label: string): string | undefined {
  for (const section of detail.sections) {
    const match = section.fields?.find((field) => field.label === label);
    if (match !== undefined) return match.value;
  }
  return undefined;
}

export function recordOf(
  records: readonly TraceRecordDto[],
  predicate: (record: TraceRecordDto) => boolean,
): TraceRecordDto {
  const record = records.find(predicate);
  expect(record).toBeDefined();
  if (record === undefined) throw new Error('expected a matching Trace record');
  return record;
}

export function detailOf(
  details: Readonly<Record<string, TraceRecordDetailDto>>,
  record: TraceRecordDto,
): TraceRecordDetailDto {
  const detail = details[record.id];
  expect(detail).toBeDefined();
  if (detail === undefined) throw new Error(`expected Inspector detail for ${record.id}`);
  return detail;
}
