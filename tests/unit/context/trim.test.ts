import { describe, expect, it } from 'vitest';

import { approxTokensForText, approxTokensForValue } from '../../../src/context/index.js';
import { truncateToLimit, trimHeadTail } from '../../../src/context/trim.js';

describe('approx tokens', () => {
  it('estimates four characters per token', () => {
    expect(approxTokensForText('')).toBe(0);
    expect(approxTokensForText('abcd')).toBe(1);
    expect(approxTokensForText('abcde')).toBe(2);
  });

  it('estimates tokens for arbitrary JSON values', () => {
    expect(approxTokensForValue({ a: 1 })).toBeGreaterThan(0);
    expect(approxTokensForValue('text')).toBe(approxTokensForText('"text"'));
  });
});

describe('truncateToLimit', () => {
  it('returns text unchanged when it fits', () => {
    const result = truncateToLimit('short', 100);
    expect(result).toEqual({ text: 'short', truncated: false, originalSize: 5, keptSize: 5 });
  });

  it('appends an explicit truncation marker when cutting', () => {
    const result = truncateToLimit('a'.repeat(300), 100);
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(300);
    expect(result.text).toContain('truncated 200 characters');
    expect(result.text.startsWith('a')).toBe(true);
  });
});

describe('trimHeadTail', () => {
  it('keeps short text untouched', () => {
    const result = trimHeadTail('abcdef', { headChars: 4, tailChars: 4 });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('abcdef');
  });

  it('keeps head and tail with a marker in the middle', () => {
    const text = `${'h'.repeat(50)}middle${'t'.repeat(50)}`;
    const result = trimHeadTail(text, { headChars: 10, tailChars: 10 });

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('h'.repeat(10))).toBe(true);
    expect(result.text.endsWith('t'.repeat(10))).toBe(true);
    expect(result.text).toContain('truncated');
  });
});
