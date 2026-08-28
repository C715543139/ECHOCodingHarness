import { describe, expect, it, vi } from 'vitest';

import type { ToolContext, ToolDefinition } from '../../../src/contracts/index.js';
import { normalizeToolInput, ToolRegistry, toolCallSignature } from '../../../src/tools/index.js';

const context: ToolContext = {
  sessionId: 'session',
  turnId: 'turn',
  stepId: 'step',
  toolCallId: 'call',
  workspaceRoot: 'C:\\workspace',
  signal: new AbortController().signal,
  limits: { timeoutMs: 100, maxOutputChars: 100 },
};

function definition(name = 'inspect'): ToolDefinition<unknown> {
  return {
    name,
    description: 'Inspect input.',
    inputSchema: { type: 'object' },
    execute: vi.fn().mockResolvedValue({
      status: 'completed',
      summary: 'ok',
      data: null,
      truncated: false,
    }),
  };
}

describe('ToolRegistry', () => {
  it('exposes Provider definitions and dispatches only registered tools', async () => {
    const inspect = definition();
    const registry = new ToolRegistry([inspect]);

    expect(registry.definitions()).toEqual([
      { name: 'inspect', description: 'Inspect input.', inputSchema: { type: 'object' } },
    ]);
    await expect(registry.execute('inspect', { value: 1 }, context)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(registry.execute('missing', {}, context)).toBeUndefined();
  });

  it('rejects duplicate registrations', () => {
    expect(() => new ToolRegistry([definition(), definition()])).toThrow(
      'registered more than once',
    );
  });

  it('normalizes JSON objects recursively with stable key order', () => {
    const normalized = normalizeToolInput({ z: [{ b: 2, a: 1 }], a: true });

    expect(normalized).toEqual({ ok: true, value: { a: true, z: [{ a: 1, b: 2 }] } });
    if (normalized.ok) {
      expect(toolCallSignature('inspect', normalized.value)).toBe(
        'inspect\0{"a":true,"z":[{"a":1,"b":2}]}',
      );
    }
  });

  it('rejects accessors, non-finite numbers, and non-JSON values before policy evaluation', () => {
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'value' });

    expect(normalizeToolInput(accessor)).toMatchObject({ ok: false });
    expect(normalizeToolInput({ value: Number.NaN })).toMatchObject({ ok: false });
    expect(normalizeToolInput({ value: undefined })).toMatchObject({ ok: false });
    expect(normalizeToolInput(new Date())).toMatchObject({ ok: false });
  });
});
