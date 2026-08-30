import { describe, expect, it } from 'vitest';

import {
  aggregateReasoning,
  extractReasoningDelta,
  isJsonSerializable,
  isReasoningPayload,
} from '../../../src/provider/reasoning.js';

describe('reasoning helpers', () => {
  it('extracts allowed reasoning fields and ignores unknown keys', () => {
    expect(
      extractReasoningDelta({
        reasoning: 'a',
        reasoning_content: 'b',
        reasoning_details: [{ type: 'text', text: 'c' }],
        extra: 'drop',
      }),
    ).toEqual({
      reasoning: 'a',
      reasoningContent: 'b',
      reasoningDetails: [{ type: 'text', text: 'c' }],
    });
    expect(extractReasoningDelta({ content: 'visible' })).toBeUndefined();
  });

  it('keeps reasoning_details order and rejects unserializable values', () => {
    expect(
      extractReasoningDelta({
        reasoning_details: [{ id: 1 }, { id: 2 }],
      })?.reasoningDetails,
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect(isJsonSerializable([{ ok: true }])).toBe(true);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isJsonSerializable(cyclic)).toBe(false);
    expect(extractReasoningDelta({ reasoning_details: cyclic })).toBeUndefined();
  });

  it('concatenates string fields in arrival order without trimming', () => {
    expect(
      aggregateReasoning([
        { reasoning: '  one' },
        { reasoning: ' two  ' },
        { reasoningContent: 'A' },
        { reasoningContent: 'B' },
        { reasoningDetails: [{ n: 1 }] },
        { reasoningDetails: [{ n: 2 }] },
      ]),
    ).toEqual({
      reasoning: '  one two  ',
      reasoningContent: 'AB',
      reasoningDetails: [{ n: 1 }, { n: 2 }],
    });
    expect(aggregateReasoning([])).toBeUndefined();
  });

  it('A: omits equivalent plain text details after string aggregation', () => {
    expect(
      aggregateReasoning([
        { reasoning: 'ab' },
        { reasoning: 'cd' },
        {
          reasoningDetails: [{ type: 'reasoning.text', text: 'a', format: 'x', index: 0 }],
        },
        {
          reasoningDetails: [{ type: 'reasoning.text', text: 'bcd', format: 'x', index: 0 }],
        },
      ]),
    ).toEqual({ reasoning: 'abcd' });
  });

  it('B: canonicalizes details-only plain text into reasoning', () => {
    expect(
      aggregateReasoning([
        {
          reasoningDetails: [
            { type: 'reasoning.text', text: 'a', format: 'x', index: 0 },
            { type: 'reasoning.text', text: 'b', format: 'x', index: 0 },
          ],
        },
      ]),
    ).toEqual({ reasoning: 'ab' });
  });

  it('C: omits plain text details equivalent to reasoningContent', () => {
    expect(
      aggregateReasoning([
        { reasoningContent: 'ab' },
        {
          reasoningDetails: [{ type: 'reasoning.text', text: 'ab', format: 'x', index: 0 }],
        },
      ]),
    ).toEqual({ reasoningContent: 'ab' });
  });

  it('D: preserves plain text details when the joined text differs', () => {
    const reasoningDetails = [{ type: 'reasoning.text', text: 'ab', format: 'x', index: 0 }];
    expect(aggregateReasoning([{ reasoning: 'different' }, { reasoningDetails }])).toEqual({
      reasoning: 'different',
      reasoningDetails,
    });
  });

  it.each([
    ['E1 id', [{ type: 'reasoning.text', text: 'ab', id: 'detail-1' }]],
    ['E2 signature', [{ type: 'reasoning.text', text: 'ab', signature: 'sig-1' }]],
    ['E3 encrypted', [{ type: 'reasoning.encrypted', data: 'blob', id: 'enc-1' }]],
    ['E4 summary', [{ type: 'reasoning.summary', summary: 'short' }]],
    ['E5 unknown', [{ type: 'provider.custom', payload: 1 }]],
    [
      'E6 mixed',
      [
        { type: 'reasoning.text', text: 'ab' },
        { type: 'reasoning.encrypted', data: 'blob' },
      ],
    ],
    ['E7 empty text', [{ type: 'reasoning.text', text: '', format: 'x', index: 0 }]],
  ] as const)('%s: preserves the complete details array', (_name, reasoningDetails) => {
    expect(aggregateReasoning([{ reasoning: 'ab' }, { reasoningDetails }])).toEqual({
      reasoning: 'ab',
      reasoningDetails,
    });
  });

  it('keeps details-only arrays in arrival order', () => {
    expect(
      aggregateReasoning([{ reasoningDetails: [{ n: 1 }] }, { reasoningDetails: [{ n: 2 }] }]),
    ).toEqual({
      reasoningDetails: [{ n: 1 }, { n: 2 }],
    });
  });

  it('accepts only non-empty structured reasoning payloads', () => {
    expect(isReasoningPayload({ reasoning: 'kept' })).toBe(true);
    expect(isReasoningPayload({})).toBe(false);
    expect(isReasoningPayload({ reasoning: 1 })).toBe(false);
    expect(isReasoningPayload({ extra: 'no' })).toBe(false);
  });
});
