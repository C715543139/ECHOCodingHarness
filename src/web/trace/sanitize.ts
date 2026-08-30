import { WEB_BOUNDS } from '../../contracts/web.js';
import { redactText, type RedactionOptions } from '../../session/redaction.js';

const SENSITIVE_KEY =
  /^(?:reasoning(?:_?(?:content|details))?|reasoningDetails|reasoningContent|chunk|text_delta|textDelta|raw(?:Payload)?|jsonl|api[_-]?key|authorization|stack(?:Trace)?)$/iu;

const WINDOWS_ABS = /[A-Za-z]:[\\/][^\s"'`,;)]+/gu;
const UNC_ABS = /\\\\[^\s"'`,;)]+/gu;
const POSIX_ABS =
  /(?<=^|[\s"'`=:])\/(?:home|Users|var|tmp|opt|usr|private|Volumes|mnt|root|repo)[^\s"'`,;)]*/gu;

export const TRACE_UNAVAILABLE = 'unavailable';

export type ProjectionRedaction = RedactionOptions;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || key.toLowerCase().includes('reasoning');
}

export function isAbsoluteDisplayPath(value: string): boolean {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) return true;
  if (trimmed.startsWith('\\\\')) return true;
  if (trimmed.startsWith('//') && trimmed.length > 2 && trimmed[2] !== '.') return true;
  return trimmed.startsWith('/') && !trimmed.startsWith('./');
}

export function boundText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export function scrubAbsolutePaths(text: string): string {
  return text
    .replace(WINDOWS_ABS, TRACE_UNAVAILABLE)
    .replace(UNC_ABS, TRACE_UNAVAILABLE)
    .replace(POSIX_ABS, TRACE_UNAVAILABLE);
}

export function displayText(text: string, redaction: ProjectionRedaction = {}): string {
  return scrubAbsolutePaths(redactText(text, redaction));
}

export function fieldText(
  text: string,
  max: number = WEB_BOUNDS.textMax,
  redaction: ProjectionRedaction = {},
): string {
  const bounded = boundText(displayText(text, redaction), max);
  return bounded.text.length === 0 ? TRACE_UNAVAILABLE : bounded.text;
}

export function bodyText(
  text: string,
  max: number = WEB_BOUNDS.bodyMax,
  redaction: ProjectionRedaction = {},
): { text: string; truncated: boolean } {
  return boundText(displayText(text, redaction), max);
}

export function dropSensitive(
  value: unknown,
  depth = 0,
  redaction: ProjectionRedaction = {},
): unknown {
  if (depth > 8) return undefined;
  if (typeof value === 'string') {
    const displayed = displayText(value, redaction);
    return isAbsoluteDisplayPath(value.trim()) && !displayed.includes('<workspace>')
      ? TRACE_UNAVAILABLE
      : displayed;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => dropSensitive(item, depth + 1, redaction));
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    const next = dropSensitive(item, depth + 1, redaction);
    if (next !== undefined) output[key] = next;
  }
  return output;
}

export function summarizeUnknown(
  value: unknown,
  max: number = WEB_BOUNDS.textMax,
  redaction: ProjectionRedaction = {},
): string | undefined {
  const cleaned = dropSensitive(value, 0, redaction);
  if (cleaned === undefined) return undefined;
  if (typeof cleaned === 'string') return fieldText(cleaned, max, redaction);
  try {
    return fieldText(JSON.stringify(cleaned), max, redaction);
  } catch {
    return TRACE_UNAVAILABLE;
  }
}

function workspacePrefixes(workspaceRoot: string): readonly string[] {
  const trimmed = workspaceRoot.trim();
  if (trimmed.length === 0) return [];
  const forward = trimmed.replaceAll('\\', '/').replace(/\/+$/u, '');
  const backward = trimmed.replaceAll('/', '\\').replace(/\\+$/u, '');
  return forward === backward ? [forward] : [forward, backward];
}

export function relativeWorkspacePath(
  value: string,
  redaction: ProjectionRedaction = {},
): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) return undefined;
  if (trimmed === '.' || trimmed === '..') return undefined;

  const workspaceRoot = redaction.workspaceRoot;
  if (workspaceRoot !== undefined && workspaceRoot.length > 0) {
    const candidate = trimmed.replaceAll('\\', '/');
    for (const prefix of workspacePrefixes(workspaceRoot)) {
      const normalizedPrefix = prefix.replaceAll('\\', '/');
      const matches =
        candidate === normalizedPrefix ||
        candidate.toLocaleLowerCase('en-US') === normalizedPrefix.toLocaleLowerCase('en-US') ||
        candidate.startsWith(`${normalizedPrefix}/`) ||
        candidate
          .toLocaleLowerCase('en-US')
          .startsWith(`${normalizedPrefix.toLocaleLowerCase('en-US')}/`);
      if (!matches) continue;
      const relative = candidate.slice(normalizedPrefix.length).replace(/^\/+/u, '');
      if (relative.length === 0 || relative.split('/').includes('..')) return undefined;
      const bounded = boundText(relative, WEB_BOUNDS.titleMax);
      return bounded.text.length === 0 ? undefined : bounded.text;
    }
  }

  if (isAbsoluteDisplayPath(trimmed)) return undefined;
  const normalized = trimmed.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) return undefined;
  const bounded = boundText(normalized, WEB_BOUNDS.titleMax);
  return bounded.text.length === 0 ? undefined : bounded.text;
}

export function metaString(
  metadata: Readonly<Record<string, string | number | boolean | null>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function metaNumber(
  metadata: Readonly<Record<string, string | number | boolean | null>> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function metaBoolean(
  metadata: Readonly<Record<string, string | number | boolean | null>> | undefined,
  key: string,
): boolean {
  return metadata?.[key] === true;
}
