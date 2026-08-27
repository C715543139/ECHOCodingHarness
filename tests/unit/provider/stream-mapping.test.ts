import { describe, expect, it } from 'vitest';

import { mapFinishReason } from '../../../src/provider/finish-reason.js';
import {
  collectStreamedToolCalls,
  parseToolCallArguments,
} from '../../../src/provider/stream-aggregation.js';

describe('mapFinishReason', () => {
  it('maps known OpenAI finish reasons to ECHO reasons', () => {
    expect(mapFinishReason('stop')).toBe('stop');
    expect(mapFinishReason('length')).toBe('length');
    expect(mapFinishReason('tool_calls')).toBe('tool_calls');
    expect(mapFinishReason('content_filter')).toBe('content_filter');
  });

  it('treats the legacy function_call reason as tool_calls', () => {
    expect(mapFinishReason('function_call')).toBe('tool_calls');
  });

  it('falls back to unknown for null, undefined, and unexpected values', () => {
    expect(mapFinishReason(null)).toBe('unknown');
    expect(mapFinishReason(undefined)).toBe('unknown');
    expect(mapFinishReason('weird')).toBe('unknown');
  });
});

describe('collectStreamedToolCalls', () => {
  it('aggregates split argument fragments for one call', () => {
    const calls = collectStreamedToolCalls([
      { index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"pa' } },
      { index: 0, function: { arguments: 'th":"src/a.ts"}' } },
    ]);

    expect(calls).toEqual([{ id: 'call-1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }]);
  });

  it('keeps multiple calls ordered by stream index', () => {
    const calls = collectStreamedToolCalls([
      { index: 1, id: 'call-2', function: { name: 'b', arguments: '{}' } },
      { index: 0, id: 'call-1', function: { name: 'a', arguments: '{}' } },
    ]);

    expect(calls.map((call) => call.id)).toEqual(['call-1', 'call-2']);
  });

  it('ignores fragments without a usable index', () => {
    const calls = collectStreamedToolCalls([
      { function: { name: 'x', arguments: '{}' } },
      { index: -1, function: { name: 'y', arguments: '{}' } },
    ]);
    expect(calls).toEqual([]);
  });

  it('falls back to a positional id when the stream sends none', () => {
    const calls = collectStreamedToolCalls([
      { index: 0, function: { name: 'read_file', arguments: '{}' } },
    ]);
    expect(calls[0]?.id).toBe('call_0');
  });
});

describe('parseToolCallArguments', () => {
  it('parses a JSON object payload', () => {
    expect(parseToolCallArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it('treats empty argument text as an empty object', () => {
    expect(parseToolCallArguments('')).toEqual({});
    expect(parseToolCallArguments('   ')).toEqual({});
  });

  it('throws for malformed JSON so callers can classify protocol errors', () => {
    expect(() => parseToolCallArguments('{oops')).toThrow();
  });
});
