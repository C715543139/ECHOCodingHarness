import type { ModelCatalogSource } from './config.js';
import type { EchoError } from './errors.js';
import type { ToolCallId } from './identifiers.js';

export interface ModelProvider {
  readonly name: string;

  stream(
    request: ModelRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<ModelStreamEvent>;
}

/**
 * Separate from `ModelProvider.stream`. Chat `/model` and `/model refresh` are
 * the only intended callers; `run` must not list models.
 */
export interface ModelCatalogClient {
  listModelIds(
    options: Readonly<{ signal: AbortSignal; timeoutMs?: number }>,
  ): Promise<readonly string[]>;
}

export interface ModelCatalogSnapshot {
  readonly status: 'ok' | 'failed';
  readonly source: ModelCatalogSource;
  readonly models: readonly string[];
  readonly cached: boolean;
  readonly refreshed: boolean;
  readonly configuredModel: string;
  readonly error?: EchoError;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelReasoning {
  readonly reasoning?: string;
  readonly reasoningContent?: string;
  readonly reasoningDetails?: readonly unknown[];
}

export type ModelReasoningDelta = ModelReasoning;

export type ModelMessage =
  | Readonly<{ role: 'system'; content: string }>
  | Readonly<{ role: 'user'; content: string }>
  | Readonly<{
      role: 'assistant';
      content: string;
      reasoning?: string;
      reasoningContent?: string;
      reasoningDetails?: readonly unknown[];
      toolCalls?: readonly ModelToolCall[];
    }>
  | Readonly<{ role: 'tool'; toolCallId: ToolCallId; content: string }>;

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly arguments: unknown;
}

export type ModelStreamEvent =
  | Readonly<{ type: 'text_delta'; delta: string }>
  | Readonly<{ type: 'reasoning_delta'; delta: ModelReasoningDelta }>
  | Readonly<{ type: 'tool_call_delta'; callId: ToolCallId; delta: string }>
  | Readonly<{ type: 'tool_call'; call: ModelToolCall }>
  | Readonly<{ type: 'usage'; inputTokens?: number; outputTokens?: number }>
  | Readonly<{ type: 'completed'; finishReason: ModelFinishReason }>;

export type ModelFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';
