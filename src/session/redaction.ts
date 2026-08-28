import * as os from 'node:os';

const REDACTED = '[REDACTED]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function replaceLiteral(text: string, value: string, replacement: string): string {
  if (value.length === 0) return text;
  return text.replace(new RegExp(escapeRegExp(value), 'giu'), replacement);
}

function replacePath(text: string, value: string, replacement: string): string {
  let redacted = replaceLiteral(text, value, replacement);
  const alternate = value.includes('\\')
    ? value.replaceAll('\\', '/')
    : value.replaceAll('/', '\\');
  if (alternate !== value) redacted = replaceLiteral(redacted, alternate, replacement);
  return redacted;
}

export interface RedactionOptions {
  readonly secrets?: readonly string[];
  readonly workspaceRoot?: string;
  readonly homeDirectory?: string;
}

export function redactText(text: string, options: RedactionOptions = {}): string {
  let redacted = text;
  for (const secret of options.secrets ?? []) {
    if (secret.trim().length > 0) redacted = replaceLiteral(redacted, secret, REDACTED);
  }
  redacted = redacted
    .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/giu, `$1${REDACTED}`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gu, `$1${REDACTED}`)
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*)[^\s,;]+/giu,
      `$1${REDACTED}`,
    )
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/giu, `$1${REDACTED}`);

  const home = options.homeDirectory ?? os.homedir();
  if (home.length > 0) redacted = replacePath(redacted, home, '<home>');
  if (options.workspaceRoot !== undefined && options.workspaceRoot.length > 0) {
    redacted = replacePath(redacted, options.workspaceRoot, '<workspace>');
  }
  return redacted;
}

function redactUnknown(value: unknown, options: RedactionOptions, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value, options);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, options, seen) ?? null);
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === 'cause') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) continue;
    const sanitized = redactUnknown(descriptor.value, options, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  return redactUnknown(value, options, new WeakSet<object>());
}
