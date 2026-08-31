import type {
  ExtensionCatalog,
  ExtensionCatalogEntry,
  ExtensionState,
} from '../contracts/index.js';

import { ExtensionStorageError } from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import { assertValidExtensionId, assertValidToolName, assertValidVersion } from './manifest.js';

const CATALOG_KEYS = ['schemaVersion', 'revision', 'extensions'] as const;
const ENTRY_KEYS = [
  'id',
  'version',
  'contentHash',
  'state',
  'tools',
  'installedAt',
  'quarantineReason',
  'cleanupPending',
] as const;
const STATES = new Set<ExtensionState>(['enabled', 'disabled', 'quarantined']);

function corrupt(message: string): never {
  throw new ExtensionStorageError('CATALOG_CORRUPT', message);
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
  if (unknown !== undefined) corrupt(`${path} contains unknown field "${unknown}".`);
}

function validateEntry(value: unknown, index: number): ExtensionCatalogEntry {
  const entryPath = `extensions[${String(index)}]`;
  if (!isRecord(value)) corrupt(`${entryPath} must be an object.`);
  assertOnlyKeys(value, ENTRY_KEYS, entryPath);
  try {
    assertValidExtensionId(value['id'], `${entryPath}.id`);
    assertValidVersion(value['version'], `${entryPath}.version`);
  } catch (error) {
    throw new ExtensionStorageError(
      'CATALOG_CORRUPT',
      `${entryPath} has an invalid identity or version.`,
      error,
    );
  }
  if (
    typeof value['contentHash'] !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value['contentHash'])
  ) {
    corrupt(`${entryPath}.contentHash must use sha256:<hex>.`);
  }
  if (typeof value['state'] !== 'string' || !STATES.has(value['state'] as ExtensionState)) {
    corrupt(`${entryPath}.state must be enabled, disabled, or quarantined.`);
  }
  if (
    !Array.isArray(value['tools']) ||
    value['tools'].length === 0 ||
    value['tools'].length > EXTENSION_LIMITS.toolCount
  ) {
    corrupt(`${entryPath}.tools has an invalid length.`);
  }
  const tools = value['tools'].map((tool, toolIndex) => {
    try {
      assertValidToolName(tool, `${entryPath}.tools[${String(toolIndex)}]`);
    } catch (error) {
      throw new ExtensionStorageError(
        'CATALOG_CORRUPT',
        `${entryPath}.tools contains an invalid name.`,
        error,
      );
    }
    return tool;
  });
  if (new Set(tools).size !== tools.length) corrupt(`${entryPath}.tools must be unique.`);
  if (typeof value['installedAt'] !== 'string')
    corrupt(`${entryPath}.installedAt must be an ISO timestamp.`);
  const timestamp = new Date(value['installedAt']);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value['installedAt']) {
    corrupt(`${entryPath}.installedAt must be a canonical ISO timestamp.`);
  }
  const quarantineReason = value['quarantineReason'];
  if (
    quarantineReason !== undefined &&
    (typeof quarantineReason !== 'string' ||
      quarantineReason.length === 0 ||
      quarantineReason.length > EXTENSION_LIMITS.quarantineReasonLength)
  ) {
    corrupt(`${entryPath}.quarantineReason is invalid.`);
  }
  if (value['cleanupPending'] !== undefined && typeof value['cleanupPending'] !== 'boolean') {
    corrupt(`${entryPath}.cleanupPending must be boolean when present.`);
  }
  return {
    id: value['id'],
    version: value['version'],
    contentHash: value['contentHash'],
    state: value['state'] as ExtensionState,
    tools,
    installedAt: value['installedAt'],
    ...(quarantineReason === undefined ? {} : { quarantineReason }),
    ...(value['cleanupPending'] === undefined ? {} : { cleanupPending: value['cleanupPending'] }),
  };
}

export function validateExtensionCatalog(
  value: unknown,
  builtInToolNames: ReadonlySet<string>,
): ExtensionCatalog {
  if (!isRecord(value)) corrupt('Extension catalog must be an object.');
  if (value['schemaVersion'] !== 1) {
    throw new ExtensionStorageError(
      'CATALOG_VERSION_UNSUPPORTED',
      'Extension catalog schemaVersion is not supported.',
    );
  }
  assertOnlyKeys(value, CATALOG_KEYS, 'catalog');
  if (
    typeof value['revision'] !== 'number' ||
    !Number.isSafeInteger(value['revision']) ||
    value['revision'] < 0
  ) {
    corrupt('catalog.revision must be a non-negative safe integer.');
  }
  if (
    !Array.isArray(value['extensions']) ||
    value['extensions'].length > EXTENSION_LIMITS.catalogEntries
  ) {
    corrupt('catalog.extensions must be a bounded array.');
  }
  const extensions = value['extensions'].map(validateEntry);
  const extensionIds = extensions.map((entry) => entry.id);
  if (new Set(extensionIds).size !== extensionIds.length)
    corrupt('catalog extension ids must be unique.');
  const owners = new Map<string, string>();
  for (const entry of extensions) {
    for (const toolName of entry.tools) {
      if (toolName.startsWith('extension_') || builtInToolNames.has(toolName)) {
        throw new ExtensionStorageError(
          'TOOL_NAME_CONFLICT',
          `Tool name "${toolName}" is reserved or built in.`,
        );
      }
      const owner = owners.get(toolName);
      if (owner !== undefined) {
        throw new ExtensionStorageError(
          'TOOL_NAME_CONFLICT',
          `Tool name "${toolName}" is already owned by extension "${owner}".`,
        );
      }
      owners.set(toolName, entry.id);
    }
  }
  return { schemaVersion: 1, revision: value['revision'], extensions };
}

export function parseExtensionCatalog(
  text: string,
  builtInToolNames: ReadonlySet<string>,
): ExtensionCatalog {
  if (Buffer.byteLength(text, 'utf8') > EXTENSION_LIMITS.catalogBytes) {
    corrupt('Extension catalog exceeds the maximum encoded size.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    corrupt('Extension catalog is not valid JSON.');
  }
  return validateExtensionCatalog(value, builtInToolNames);
}

export function serializeExtensionCatalog(catalog: ExtensionCatalog): string {
  const sorted: ExtensionCatalog = {
    ...catalog,
    extensions: [...catalog.extensions].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
