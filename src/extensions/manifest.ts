import type { ExtensionManifest, ExtensionToolManifest } from '../contracts/index.js';

import { ExtensionStorageError } from './errors.js';
import { validateToolInputSchema } from './json-schema.js';
import { EXTENSION_LIMITS } from './limits.js';

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MANIFEST_KEYS = ['schemaVersion', 'id', 'version', 'entry', 'selfTest', 'tools'] as const;
const TOOL_KEYS = ['name', 'description', 'inputSchema'] as const;

function invalid(
  code: 'MANIFEST_INVALID' | 'MANIFEST_PATH_INVALID' | 'TOOL_NAME_CONFLICT',
  message: string,
): never {
  throw new ExtensionStorageError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    invalid('MANIFEST_INVALID', `${path} contains unknown field "${unknown}".`);
}

function readBoundedString(value: unknown, path: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    invalid(
      'MANIFEST_INVALID',
      `${path} must be a non-empty string of at most ${String(maximum)} characters.`,
    );
  }
  return value;
}

export function assertValidExtensionId(value: unknown, path = 'id'): asserts value is string {
  const id = readBoundedString(value, path, EXTENSION_LIMITS.extensionIdLength);
  if (!EXTENSION_ID_PATTERN.test(id)) {
    invalid('MANIFEST_INVALID', `${path} must be lower-case kebab-case.`);
  }
}

export function assertValidToolName(value: unknown, path = 'name'): asserts value is string {
  const name = readBoundedString(value, path, EXTENSION_LIMITS.toolNameLength);
  if (!TOOL_NAME_PATTERN.test(name)) {
    invalid('MANIFEST_INVALID', `${path} must be lower_snake_case.`);
  }
}

export function assertValidVersion(value: unknown, path = 'version'): asserts value is string {
  const version = readBoundedString(value, path, EXTENSION_LIMITS.versionLength);
  if (!VERSION_PATTERN.test(version)) invalid('MANIFEST_INVALID', `${path} must use x.y.z.`);
}

function isAbsoluteOnAnyPlatform(value: string): boolean {
  return /^(?:[A-Za-z]:|[/\\]{2})/u.test(value) || value.startsWith('/') || value.startsWith('\\');
}

function isWindowsDeviceName(segment: string): boolean {
  const base =
    segment
      .replace(/[ .]+$/u, '')
      .split('.')[0]
      ?.toUpperCase() ?? '';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)$/u.test(base);
}

export function normalizeExtensionRelativePath(value: unknown, kind: 'entry' | 'selfTest'): string {
  const input = readBoundedString(value, kind, EXTENSION_LIMITS.relativePathLength);
  if (isAbsoluteOnAnyPlatform(input)) {
    invalid('MANIFEST_PATH_INVALID', `${kind} must be extension-relative.`);
  }
  const rawSegments = input.split(/[\\/]+/u);
  if (rawSegments.includes('..')) {
    invalid('MANIFEST_PATH_INVALID', `${kind} cannot contain parent path segments.`);
  }
  const segments = rawSegments.filter((segment) => segment !== '' && segment !== '.');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.includes(':') || /[ .]$/u.test(segment) || isWindowsDeviceName(segment),
    )
  ) {
    invalid('MANIFEST_PATH_INVALID', `${kind} contains an unsafe path segment.`);
  }
  const normalized = segments.join('/');
  if (normalized.length > EXTENSION_LIMITS.relativePathLength) {
    invalid('MANIFEST_PATH_INVALID', `${kind} exceeds the normalized path limit.`);
  }
  if (kind === 'entry' && !normalized.endsWith('.mjs')) {
    invalid('MANIFEST_PATH_INVALID', 'entry must reference a .mjs file.');
  }
  if (kind === 'selfTest' && !normalized.endsWith('.test.mjs')) {
    invalid('MANIFEST_PATH_INVALID', 'selfTest must reference a .test.mjs file.');
  }
  return normalized;
}

function parseTool(value: unknown, index: number): ExtensionToolManifest {
  const toolPath = `tools[${String(index)}]`;
  if (!isRecord(value)) invalid('MANIFEST_INVALID', `${toolPath} must be an object.`);
  assertOnlyKeys(value, TOOL_KEYS, toolPath);
  assertValidToolName(value['name'], `${toolPath}.name`);
  const description = readBoundedString(
    value['description'],
    `${toolPath}.description`,
    EXTENSION_LIMITS.toolDescriptionLength,
  );
  if (description.trim() !== description) {
    invalid('MANIFEST_INVALID', `${toolPath}.description cannot start or end with whitespace.`);
  }
  validateToolInputSchema(value['inputSchema'], `${toolPath}.inputSchema`);
  return { name: value['name'], description, inputSchema: value['inputSchema'] };
}

export function parseExtensionManifest(text: string, expectedId?: string): ExtensionManifest {
  if (Buffer.byteLength(text, 'utf8') > EXTENSION_LIMITS.manifestBytes) {
    invalid('MANIFEST_INVALID', 'Extension manifest exceeds the maximum encoded size.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    invalid('MANIFEST_INVALID', 'Extension manifest is not valid JSON.');
  }
  if (!isRecord(value)) invalid('MANIFEST_INVALID', 'Extension manifest must be an object.');
  assertOnlyKeys(value, MANIFEST_KEYS, 'manifest');
  if (value['schemaVersion'] !== 1) {
    invalid('MANIFEST_INVALID', 'Extension manifest schemaVersion must be 1.');
  }
  assertValidExtensionId(value['id']);
  if (expectedId !== undefined && value['id'] !== expectedId) {
    invalid('MANIFEST_INVALID', `Extension manifest id must match "${expectedId}".`);
  }
  assertValidVersion(value['version']);
  const entry = normalizeExtensionRelativePath(value['entry'], 'entry');
  const selfTest = normalizeExtensionRelativePath(value['selfTest'], 'selfTest');
  if (entry === selfTest)
    invalid('MANIFEST_PATH_INVALID', 'entry and selfTest must be different files.');
  if (
    !Array.isArray(value['tools']) ||
    value['tools'].length === 0 ||
    value['tools'].length > EXTENSION_LIMITS.toolCount
  ) {
    invalid(
      'MANIFEST_INVALID',
      `tools must contain between 1 and ${String(EXTENSION_LIMITS.toolCount)} entries.`,
    );
  }
  const tools = value['tools'].map(parseTool);
  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) {
    invalid('TOOL_NAME_CONFLICT', 'Extension manifest tool names must be unique.');
  }
  return { schemaVersion: 1, id: value['id'], version: value['version'], entry, selfTest, tools };
}
