import { EXTENSION_LIMITS } from './limits.js';
import { ExtensionStorageError } from './errors.js';

const SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const ALLOWED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$anchor',
  '$defs',
  'definitions',
  'type',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'format',
  'items',
  'prefixItems',
  'contains',
  'maxContains',
  'minContains',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxProperties',
  'minProperties',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'dependentRequired',
  'dependentSchemas',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
]);

interface SchemaState {
  nodes: number;
  readonly root: Readonly<Record<string, unknown>>;
  readonly anchors: Set<string>;
  readonly references: { readonly path: string; readonly reference: string }[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function invalid(path: string, message: string): never {
  throw new ExtensionStorageError('TOOL_SCHEMA_INVALID', `${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean.');
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) invalid(path, 'must be a non-empty string.');
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    invalid(path, 'must be a finite number.');
}

function assertNonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(path, 'must be a non-negative safe integer.');
  }
}

function validateStringArray(value: unknown, path: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalid(path, `must be ${allowEmpty ? 'an' : 'a non-empty'} array of strings.`);
  }
  const strings = value.map((item, index) => {
    assertString(item, `${path}[${String(index)}]`);
    return item;
  });
  if (new Set(strings).size !== strings.length) invalid(path, 'must not contain duplicates.');
  return strings;
}

function validateSchemaMap(value: unknown, path: string, state: SchemaState): void {
  if (!isRecord(value)) invalid(path, 'must be an object of JSON Schemas.');
  for (const [key, schema] of Object.entries(value)) {
    if (key.length === 0) invalid(path, 'must not contain an empty property name.');
    validateSchemaNode(schema, `${path}.${key}`, state);
  }
}

function validateSchemaArray(value: unknown, path: string, state: SchemaState): void {
  if (!Array.isArray(value) || value.length === 0)
    invalid(path, 'must be a non-empty schema array.');
  value.forEach((schema, index) => validateSchemaNode(schema, `${path}[${String(index)}]`, state));
}

function validateSchemaNode(value: unknown, path: string, state: SchemaState): void {
  state.nodes += 1;
  if (
    state.nodes > EXTENSION_LIMITS.schemaNodes ||
    path.split('.').length > EXTENSION_LIMITS.schemaDepth
  ) {
    invalid(path, 'exceeds the supported structural limits.');
  }
  if (typeof value === 'boolean') return;
  if (!isRecord(value)) invalid(path, 'must be a JSON Schema object or boolean.');

  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYWORDS.has(key))
      invalid(`${path}.${key}`, 'is not a supported JSON Schema keyword.');
  }

  const type = value['type'];
  if (type !== undefined) {
    const types = Array.isArray(type) ? validateStringArray(type, `${path}.type`, false) : [type];
    for (const item of types) {
      assertString(item, `${path}.type`);
      if (!SCHEMA_TYPES.has(item)) invalid(`${path}.type`, `contains unsupported type "${item}".`);
    }
  }

  for (const key of ['$schema', '$id', '$anchor', 'title', 'description', 'format'] as const) {
    if (value[key] !== undefined) assertString(value[key], `${path}.${key}`);
  }
  const dialect = value['$schema'];
  if (dialect !== undefined && dialect !== 'https://json-schema.org/draft/2020-12/schema') {
    invalid(`${path}.$schema`, 'only JSON Schema draft 2020-12 is supported.');
  }
  const anchor = value['$anchor'];
  if (anchor !== undefined) {
    assertString(anchor, `${path}.$anchor`);
  }
  if (anchor !== undefined && !/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(anchor)) {
    invalid(`${path}.$anchor`, 'must be a valid plain-name anchor.');
  }
  if (anchor !== undefined) {
    if (state.anchors.has(anchor)) invalid(`${path}.$anchor`, `duplicates anchor "${anchor}".`);
    state.anchors.add(anchor);
  }
  if (value['$ref'] !== undefined) {
    assertString(value['$ref'], `${path}.$ref`);
    if (!value['$ref'].startsWith('#'))
      invalid(`${path}.$ref`, 'external references are not supported.');
    state.references.push({ path: `${path}.$ref`, reference: value['$ref'] });
  }
  for (const key of ['deprecated', 'readOnly', 'writeOnly', 'uniqueItems'] as const) {
    if (value[key] !== undefined) assertBoolean(value[key], `${path}.${key}`);
  }
  for (const key of ['maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum'] as const) {
    if (value[key] !== undefined) assertFiniteNumber(value[key], `${path}.${key}`);
  }
  if (value['multipleOf'] !== undefined) {
    assertFiniteNumber(value['multipleOf'], `${path}.multipleOf`);
    if (value['multipleOf'] <= 0) invalid(`${path}.multipleOf`, 'must be greater than zero.');
  }
  for (const key of [
    'maxLength',
    'minLength',
    'maxContains',
    'minContains',
    'maxItems',
    'minItems',
    'maxProperties',
    'minProperties',
  ] as const) {
    if (value[key] !== undefined) assertNonNegativeInteger(value[key], `${path}.${key}`);
  }
  if (value['pattern'] !== undefined) {
    assertString(value['pattern'], `${path}.pattern`);
    try {
      new RegExp(value['pattern'], 'u');
    } catch {
      invalid(`${path}.pattern`, 'must be a valid regular expression.');
    }
  }

  if (value['enum'] !== undefined) {
    if (!Array.isArray(value['enum']) || value['enum'].length === 0) {
      invalid(`${path}.enum`, 'must be a non-empty array.');
    }
    const encoded = value['enum'].map(canonicalJson);
    if (new Set(encoded).size !== encoded.length) {
      invalid(`${path}.enum`, 'must contain unique JSON values.');
    }
  }
  if (value['examples'] !== undefined && !Array.isArray(value['examples'])) {
    invalid(`${path}.examples`, 'must be an array.');
  }

  for (const key of [
    '$defs',
    'definitions',
    'properties',
    'patternProperties',
    'dependentSchemas',
  ] as const) {
    if (value[key] !== undefined) validateSchemaMap(value[key], `${path}.${key}`, state);
  }
  if (isRecord(value['patternProperties'])) {
    for (const pattern of Object.keys(value['patternProperties'])) {
      try {
        new RegExp(pattern, 'u');
      } catch {
        invalid(`${path}.patternProperties`, `contains invalid pattern "${pattern}".`);
      }
    }
  }
  if (value['required'] !== undefined) {
    const required = validateStringArray(value['required'], `${path}.required`, true);
    const properties = value['properties'];
    if (isRecord(properties)) {
      for (const key of required) {
        if (!(key in properties))
          invalid(`${path}.required`, `references undeclared property "${key}".`);
      }
    }
  }
  if (value['dependentRequired'] !== undefined) {
    if (!isRecord(value['dependentRequired']))
      invalid(`${path}.dependentRequired`, 'must be an object.');
    for (const [key, dependency] of Object.entries(value['dependentRequired'])) {
      validateStringArray(dependency, `${path}.dependentRequired.${key}`, true);
    }
  }
  for (const key of ['items', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'] as const) {
    if (value[key] !== undefined) validateSchemaNode(value[key], `${path}.${key}`, state);
  }
  if (value['additionalProperties'] !== undefined) {
    validateSchemaNode(value['additionalProperties'], `${path}.additionalProperties`, state);
  }
  for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf'] as const) {
    if (value[key] !== undefined) validateSchemaArray(value[key], `${path}.${key}`, state);
  }
}

function decodePointerSegment(segment: string, path: string): string {
  if (/~(?:[^01]|$)/u.test(segment)) invalid(path, 'contains an invalid JSON Pointer escape.');
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function assertResolvableReferences(state: SchemaState): void {
  for (const { path, reference } of state.references) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(reference.slice(1));
    } catch {
      invalid(path, 'contains invalid percent encoding.');
    }
    if (!decoded.startsWith('/')) {
      if (decoded.length === 0 || state.anchors.has(decoded)) continue;
      invalid(path, `references unknown anchor "${decoded}".`);
    }
    let target: unknown = state.root;
    for (const rawSegment of decoded.slice(1).split('/')) {
      const segment = decodePointerSegment(rawSegment, path);
      if (Array.isArray(target)) {
        if (!/^(?:0|[1-9]\d*)$/u.test(segment)) invalid(path, 'does not resolve to a schema.');
        target = target[Number(segment)];
      } else if (isRecord(target) && Object.hasOwn(target, segment)) {
        target = target[segment];
      } else {
        invalid(path, 'does not resolve to a schema.');
      }
    }
    if (typeof target !== 'boolean' && !isRecord(target)) {
      invalid(path, 'must resolve to a JSON Schema object or boolean.');
    }
  }
}

export function validateToolInputSchema(
  value: unknown,
  path = 'inputSchema',
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) invalid(path, 'must be a JSON Schema object.');
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid(path, 'must be JSON serializable.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > EXTENSION_LIMITS.toolSchemaBytes) {
    invalid(path, 'exceeds the maximum encoded size.');
  }
  const state: SchemaState = { nodes: 0, root: value, anchors: new Set(), references: [] };
  validateSchemaNode(value, path, state);
  assertResolvableReferences(state);
  if (value['type'] !== 'object')
    invalid(`${path}.type`, 'the tool input root must use type "object".');
  if (value['additionalProperties'] !== false) {
    invalid(`${path}.additionalProperties`, 'the tool input root must reject unknown properties.');
  }
}
