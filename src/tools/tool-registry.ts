import type {
  EchoError,
  ModelToolDefinition,
  ToolContext,
  ToolDefinition,
  ToolExecution,
} from '../contracts/index.js';

export type RegisteredTool = ToolDefinition<never, unknown>;

interface NormalizationState {
  nodes: number;
}

export type InputNormalization =
  Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: EchoError }>;

const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 10_000;

function invalidInput(message: string): InputNormalization {
  return {
    ok: false,
    error: {
      category: 'invalid_tool_input',
      code: 'INVALID_TOOL_ARGUMENTS',
      message,
      retryable: false,
    },
  };
}

function normalizeNode(value: unknown, depth: number, state: NormalizationState): unknown {
  state.nodes += 1;
  if (depth > MAX_INPUT_DEPTH || state.nodes > MAX_INPUT_NODES) {
    throw new TypeError('Tool arguments exceed the supported structural limits.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Tool arguments must contain finite numbers.');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeNode(item, depth + 1, state));
  }
  if (typeof value !== 'object') {
    throw new TypeError('Tool arguments must be JSON-compatible.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Tool arguments must use plain JSON objects.');
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('Tool arguments must not contain accessors.');
    }
    result[key] = normalizeNode(descriptor.value, depth + 1, state);
  }
  return result;
}

export function normalizeToolInput(value: unknown): InputNormalization {
  try {
    return { ok: true, value: normalizeNode(value, 0, { nodes: 0 }) };
  } catch (error) {
    return invalidInput(
      error instanceof Error ? error.message : 'Tool arguments could not be safely inspected.',
    );
  }
}

export function toolCallSignature(toolName: string, normalizedInput: unknown): string {
  return `${toolName}\0${JSON.stringify(normalizedInput)}`;
}

export class ToolRegistry {
  private readonly entries = new Map<string, RegisteredTool>();

  constructor(tools: readonly RegisteredTool[]) {
    for (const tool of tools) {
      if (this.entries.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is registered more than once.`);
      }
      this.entries.set(tool.name, tool);
    }
  }

  definitions(): readonly ModelToolDefinition[] {
    return [...this.entries.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  execute(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolExecution<unknown>> | undefined {
    const tool = this.entries.get(name);
    return tool?.execute(input as never, context);
  }
}
