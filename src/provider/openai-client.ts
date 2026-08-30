import { OpenAI } from 'openai';

import { toEchoError } from './errors.js';
import type { OpenAICompatibleClient } from './openai-compatible-provider.js';
import { extractReasoningDelta } from './reasoning.js';

type WireChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

interface NormalizedChunk {
  readonly choices: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly Readonly<Record<string, unknown>>[] | undefined;
      readonly reasoning?: string | null;
      readonly reasoning_content?: string | null;
      readonly reasoning_details?: readonly unknown[];
    } | null;
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  } | null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function normalizeChunk(chunk: WireChunk): NormalizedChunk {
  return {
    choices: chunk.choices.map((choice) => {
      const rawDelta = asRecord(choice.delta);
      const reasoning = extractReasoningDelta(rawDelta);
      return {
        delta: choice.delta
          ? {
              content: choice.delta.content ?? null,
              tool_calls: choice.delta.tool_calls?.map(
                (call) => call as unknown as Readonly<Record<string, unknown>>,
              ),
              ...(reasoning?.reasoning === undefined ? {} : { reasoning: reasoning.reasoning }),
              ...(reasoning?.reasoningContent === undefined
                ? {}
                : { reasoning_content: reasoning.reasoningContent }),
              ...(reasoning?.reasoningDetails === undefined
                ? {}
                : { reasoning_details: reasoning.reasoningDetails }),
            }
          : null,
        finish_reason: choice.finish_reason ?? null,
      };
    }),
    usage: chunk.usage
      ? {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
        }
      : null,
  };
}

export function createOpenAIClient(
  options: Readonly<{ baseUrl: string; apiKey: string; timeoutMs?: number }>,
): OpenAICompatibleClient {
  const client = new OpenAI({
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
    maxRetries: 0,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
  return {
    async createStream(wireRequest, requestOptions) {
      const stream = await client.chat.completions.create(
        wireRequest as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        {
          signal: requestOptions.signal,
          ...(requestOptions.timeoutMs !== undefined ? { timeout: requestOptions.timeoutMs } : {}),
        },
      );
      async function* toChunks(): AsyncGenerator<NormalizedChunk> {
        for await (const chunk of stream) {
          yield normalizeChunk(chunk);
        }
      }
      return toChunks();
    },
    async listModelIds(requestOptions) {
      try {
        const page = await client.models.list({
          signal: requestOptions.signal,
          ...(requestOptions.timeoutMs !== undefined ? { timeout: requestOptions.timeoutMs } : {}),
        });
        const ids: string[] = [];
        for await (const model of page) {
          if (typeof model.id === 'string' && model.id.trim().length > 0) {
            ids.push(model.id.trim());
          }
        }
        return ids;
      } catch (error) {
        throw toEchoError(error);
      }
    },
  };
}
