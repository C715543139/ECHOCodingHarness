import type { ToolCallId } from '../contracts/identifiers.js';
import type { ModelFinishReason, ModelToolCall } from '../contracts/model.js';

export interface FunctionToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface AggregatedStep {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason: ModelFinishReason;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export class ToolCallParseError extends Error {
  constructor(
    readonly callId: ToolCallId,
    readonly toolName: string,
    readonly rawArguments: string,
    cause: unknown,
  ) {
    super(
      `Tool "${toolName}" (call ${callId}) produced arguments that are not valid JSON.`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = 'ToolCallParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses streamed function tool call fragments per OpenAI-compatible chat
 * completions semantics: `id`/`name` arrive once on the first fragment for an
 * index, `arguments` fragments must be concatenated in order.
 */
export function collectStreamedToolCalls(
  fragments: readonly Readonly<Record<string, unknown>>[],
): readonly FunctionToolCall[] {
  const collected = new Map<number, { id: string; name: string; args: string }>();
  for (const fragment of fragments) {
    if (!isRecord(fragment)) {
      continue;
    }
    const index = fragment['index'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      continue;
    }
    const current = collected.get(index) ?? { id: '', name: '', args: '' };
    const rawId = fragment['id'];
    if (typeof rawId === 'string' && rawId.length > 0) {
      current.id = rawId;
    }
    const fn = fragment['function'];
    if (isRecord(fn)) {
      const rawName = fn['name'];
      if (typeof rawName === 'string' && rawName.length > 0) {
        current.name = rawName;
      }
      const rawArgs = fn['arguments'];
      if (typeof rawArgs === 'string') {
        current.args += rawArgs;
      }
    }
    collected.set(index, current);
  }
  return [...collected.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, value]) => ({
      id: value.id || `call_${index}`,
      name: value.name,
      arguments: value.args,
    }));
}

export function parseToolCallArguments(raw: string): unknown {
  if (raw.trim().length === 0) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

export function toModelToolCall(call: FunctionToolCall): ModelToolCall {
  return {
    id: call.id,
    name: call.name,
    arguments: parseToolCallArguments(call.arguments as string),
  };
}
