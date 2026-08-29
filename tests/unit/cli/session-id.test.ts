import { describe, expect, it } from 'vitest';

import { matchListedSessionId, sessionShortId } from '../../../src/cli/session-id.js';

describe('session ID matching', () => {
  const full = 'session-a13f09c2-4e5a-4b11-9c0d-1234567890ab';

  it('derives the Chat banner SESSION short id', () => {
    expect(sessionShortId(full)).toBe('a13f09c2');
  });

  it('resolves a unique banner short id and passes full ids through', () => {
    expect(matchListedSessionId(full, [full])).toEqual({ kind: 'resolved', sessionId: full });
    expect(matchListedSessionId('a13f09c2', [full])).toEqual({
      kind: 'resolved',
      sessionId: full,
    });
    expect(matchListedSessionId('missing', [full])).toEqual({ kind: 'missing' });
  });

  it('rejects an ambiguous short id instead of picking an arbitrary session', () => {
    const other = 'session-a13f09c2-ffff-4b11-9c0d-1234567890ab';
    expect(sessionShortId(other)).toBe('a13f09c2');
    expect(matchListedSessionId('a13f09c2', [full, other])).toEqual({ kind: 'ambiguous' });
  });

  it('rejects blank and path-like resume identifiers before storage lookup', () => {
    expect(matchListedSessionId('   ', [full])).toEqual({ kind: 'invalid' });
    expect(matchListedSessionId('../bad', [full])).toEqual({ kind: 'invalid' });
    expect(matchListedSessionId('bad/id', [full])).toEqual({ kind: 'invalid' });
  });
});
