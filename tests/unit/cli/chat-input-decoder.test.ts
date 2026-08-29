import { describe, expect, it } from 'vitest';

import {
  BRACKETED_PASTE_REQUIRED_FOR_MULTILINE_ATOMICITY,
  ChatInputDecoder,
} from '../../../src/cli/chat-input-decoder.js';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../../../src/contracts/index.js';

describe('ChatInputDecoder', () => {
  it('keeps one bracketed paste as a single paste batch regardless of newlines', () => {
    const decoder = new ChatInputDecoder();
    const first = decoder.push(`${BRACKETED_PASTE_START}/help\n`);
    expect(first).toEqual([]);
    const second = decoder.push(`second line${BRACKETED_PASTE_END}`);
    expect(second).toEqual([{ kind: 'batch', text: '/help\nsecond line', source: 'paste' }]);
  });

  it('splits typed Enter submissions and treats Ctrl+C as interrupt', () => {
    const decoder = new ChatInputDecoder();
    expect(decoder.push('hello\n/status\n')).toEqual([
      { kind: 'batch', text: 'hello', source: 'typed' },
      { kind: 'batch', text: '/status', source: 'typed' },
    ]);
    expect(decoder.push('partial\u0003')).toEqual([{ kind: 'interrupt' }]);
  });

  it('holds partial paste markers across chunks and documents Enter-only degradation', () => {
    const decoder = new ChatInputDecoder();
    expect(decoder.push('\u001b[20')).toEqual([]);
    expect(decoder.push(`0~one\ntwo${BRACKETED_PASTE_END}`)).toEqual([
      { kind: 'batch', text: 'one\ntwo', source: 'paste' },
    ]);
    expect(BRACKETED_PASTE_REQUIRED_FOR_MULTILINE_ATOMICITY).toContain('Without bracketed paste');

    const degraded = new ChatInputDecoder();
    expect(degraded.push('line-one\nline-two\n')).toEqual([
      { kind: 'batch', text: 'line-one', source: 'typed' },
      { kind: 'batch', text: 'line-two', source: 'typed' },
    ]);
  });
});
