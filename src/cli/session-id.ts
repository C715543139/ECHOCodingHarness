import { isSafeSessionId } from '../session/jsonl-session-store.js';

export function sessionShortId(sessionId: string): string {
  return sessionId
    .replace(/^session-/u, '')
    .replaceAll('-', '')
    .slice(0, 8);
}

export type SessionIdMatch =
  | Readonly<{ kind: 'resolved'; sessionId: string }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'ambiguous' }>
  | Readonly<{ kind: 'invalid' }>;

/**
 * Map a Chat banner / `/status` SESSION value to a unique stored session ID.
 * Full IDs pass through when they are listed; otherwise the 8-character short
 * form shown in the startup summary is accepted when it matches exactly one
 * session in the workspace.
 */
export function matchListedSessionId(
  requested: string,
  sessionIds: readonly string[],
): SessionIdMatch {
  const trimmed = requested.trim();
  if (trimmed.length === 0 || !isSafeSessionId(trimmed)) return { kind: 'invalid' };

  const exact = sessionIds.filter((sessionId) => sessionId === trimmed);
  if (exact.length === 1 && exact[0] !== undefined) {
    return { kind: 'resolved', sessionId: exact[0] };
  }

  const byShort = sessionIds.filter((sessionId) => sessionShortId(sessionId) === trimmed);
  if (byShort.length === 1 && byShort[0] !== undefined) {
    return { kind: 'resolved', sessionId: byShort[0] };
  }
  if (byShort.length > 1) return { kind: 'ambiguous' };

  return exact.length === 0 ? { kind: 'missing' } : { kind: 'ambiguous' };
}
