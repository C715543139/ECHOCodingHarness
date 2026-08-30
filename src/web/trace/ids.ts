import { WEB_BOUNDS, WEB_ID_PATTERN } from '../../contracts/web.js';

const UNSAFE_ID = /[^A-Za-z0-9._~-]/gu;

export function sanitizeTraceId(value: string): string {
  const cleaned = value.replace(UNSAFE_ID, '-').replace(/^-+/u, '').replace(/-+$/u, '');
  const id = (cleaned.length === 0 ? 'id' : cleaned).slice(0, WEB_BOUNDS.idMax);
  return WEB_ID_PATTERN.test(id) ? id : `id_${id}`.slice(0, WEB_BOUNDS.idMax);
}

export function traceRecordId(kind: string, ...parts: readonly string[]): string {
  return sanitizeTraceId([kind, ...parts].join('_'));
}
