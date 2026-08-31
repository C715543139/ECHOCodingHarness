import { afterEach, describe, expect, it } from 'vitest';

import {
  ExtensionStorageError,
  parseExtensionManifest,
  WorkspaceExtensionStore,
} from '../../../src/extensions/index.js';

import { cleanupWorkspaces, makeWorkspace, sampleManifest } from './fixtures.js';

afterEach(cleanupWorkspaces);

function parse(value: unknown) {
  return parseExtensionManifest(JSON.stringify(value));
}

describe('Extension Manifest v1', () => {
  it('round-trips a strict normalized manifest', () => {
    const parsed = parse({ ...sampleManifest(), entry: '.\\lib//index.mjs' });

    expect(parsed).toEqual({ ...sampleManifest(), entry: 'lib/index.mjs' });
  });

  it('rejects unknown manifest and tool fields', () => {
    expect(() => parse({ ...sampleManifest(), surprise: true })).toThrowError(
      expect.objectContaining({ code: 'MANIFEST_INVALID' }),
    );
    expect(() =>
      parse({
        ...sampleManifest(),
        tools: [{ ...sampleManifest().tools[0], handler: 'readPdf' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'MANIFEST_INVALID' }));
  });

  it('rejects malformed and non-strict tool JSON Schemas', () => {
    for (const inputSchema of [
      { type: 'object', additionalProperties: false, properties: { path: { type: 'wat' } } },
      { type: 'object', additionalProperties: false, unknownKeyword: true },
      { type: 'array', items: { type: 'string' } },
      { type: 'object', properties: {} },
      { type: 'object', additionalProperties: false, required: ['missing'], properties: {} },
      {
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'object',
        additionalProperties: false,
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: { mode: { enum: ['same', 'same'] } },
      },
      {
        type: 'object',
        additionalProperties: false,
        patternProperties: { '[': { type: 'string' } },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: { value: { $ref: '#/$defs/missing' } },
        $defs: { present: { type: 'string' } },
      },
    ]) {
      expect(() =>
        parse({
          ...sampleManifest(),
          tools: [{ ...sampleManifest().tools[0], inputSchema }],
        }),
      ).toThrowError(expect.objectContaining({ code: 'TOOL_SCHEMA_INVALID' }));
    }
  });

  it('accepts a bounded local JSON Schema reference when its target exists', () => {
    expect(() =>
      parse({
        ...sampleManifest(),
        tools: [
          {
            ...sampleManifest().tools[0],
            inputSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              additionalProperties: false,
              properties: { value: { $ref: '#/$defs/value' } },
              $defs: { value: { type: 'string' } },
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects absolute paths, parent traversal, wrong suffixes, and duplicate tools', () => {
    for (const entry of ['C:\\outside\\index.mjs', '/outside/index.mjs', '../index.mjs']) {
      expect(() => parse({ ...sampleManifest(), entry })).toThrowError(
        expect.objectContaining({ code: 'MANIFEST_PATH_INVALID' }),
      );
    }
    expect(() => parse({ ...sampleManifest(), selfTest: 'test.mjs' })).toThrowError(
      expect.objectContaining({ code: 'MANIFEST_PATH_INVALID' }),
    );
    const duplicate = sampleManifest().tools[0];
    expect(() => parse({ ...sampleManifest(), tools: [duplicate, duplicate] })).toThrowError(
      expect.objectContaining({ code: 'TOOL_NAME_CONFLICT' }),
    );
  });

  it('rejects built-in, lifecycle namespace, and other-extension tool conflicts', async () => {
    const store = new WorkspaceExtensionStore(await makeWorkspace(), {
      reservedToolNames: ['host_tool'],
    });
    const catalog = {
      schemaVersion: 1 as const,
      revision: 1,
      extensions: [
        {
          id: 'other-extension',
          version: '1.0.0',
          contentHash: `sha256:${'a'.repeat(64)}`,
          state: 'disabled' as const,
          tools: ['existing_tool'],
          installedAt: '2026-08-31T00:00:00.000Z',
        },
      ],
    };

    for (const name of [
      'read_file',
      'write_file',
      'host_tool',
      'extension_custom',
      'existing_tool',
    ]) {
      const baseTool = sampleManifest().tools.at(0);
      if (baseTool === undefined) throw new Error('Fixture tool is missing.');
      const manifest = sampleManifest({
        tools: [{ ...baseTool, name }],
      });
      expect(() => store.assertToolNamesAvailable(manifest, catalog)).toThrowError(
        expect.objectContaining({ code: 'TOOL_NAME_CONFLICT' }),
      );
    }
  });

  it('uses stable typed failures without exposing parser internals', () => {
    try {
      parseExtensionManifest('{bad');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionStorageError);
      expect(error).toMatchObject({ code: 'MANIFEST_INVALID' });
      expect((error as Error).message).toBe('Extension manifest is not valid JSON.');
    }
  });
});
