import type {
  EchoError,
  ModelFinishReason,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../contracts/index.js';

import { mapFinishReason } from './finish-reason.js';
import {
  DEFAULT_RETRY_POLICY,
  providerError,
  type ProviderRetryPolicy,
  toEchoError,
  withRetries,
} from './errors.js';
import { collectStreamedToolCalls, toModelToolCall } from './stream-aggregation.js';
import { toWireRequest } from './request-mapping.js';

interface StreamChunk {
  readonly choices: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly Readonly<Record<string, unknown>>[] | undefined;
    } | null;
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  } | null;
}

export interface OpenAICompatibleClient {
  createStream(
    wireRequest: Record<string, unknown>,
    options: Readonly<{ signal: AbortSignal; timeoutMs?: number }>,
  ): Promise<AsyncIterable<StreamChunk>>;
  listModelIds(
    options: Readonly<{ signal: AbortSignal; timeoutMs?: number }>,
  ): Promise<readonly string[]>;
}

export interface OpenAICompatibleProviderOptions {
  readonly client: OpenAICompatibleClient;
  readonly model: string;
  readonly requestTimeoutMs?: number;
  readonly retryPolicy?: ProviderRetryPolicy;
}

interface StreamFailure {
  readonly __streamFailed: EchoError;
}

function isStreamFailure(value: unknown): value is StreamFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__streamFailed' in (value as Record<string, unknown>)
  );
}

function mapStreamError(error: unknown): EchoError {
  if (error instanceof SyntaxError) {
    return providerError(
      'provider_protocol',
      'PROVIDER_INVALID_TOOL_ARGUMENTS',
      'The model stream contained invalid tool-call JSON.',
      false,
    );
  }
  const echoError = toEchoError(error);
  if (echoError.category === 'provider_network' && echoError.code === 'PROVIDER_REQUEST_FAILED') {
    return providerError(
      'provider_network',
      'PROVIDER_STREAM_FAILED',
      echoError.message,
      echoError.retryable,
      echoError.details === undefined ? undefined : { ...echoError.details },
    );
  }
  return echoError;
}

/**
 * Adapter for an OpenAI-compatible chat completions endpoint. It only maps
 * request/response shapes; loop control, tool execution and session state stay
 * outside this module.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';

  private readonly client: OpenAICompatibleClient;
  private readonly model: string;
  private readonly requestTimeoutMs: number | undefined;
  private readonly retryPolicy: ProviderRetryPolicy;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.client = options.client;
    this.model = options.model;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  stream(
    request: ModelRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<ModelStreamEvent> {
    const { client, model, requestTimeoutMs, retryPolicy } = this;
    async function* generate(): AsyncGenerator<ModelStreamEvent> {
      const wire = toWireRequest({ ...request, model: request.model || model });
      const chunks = await withRetries((attempt) => {
        if (attempt > 1 && options.signal.aborted) {
          throw providerError(
            'cancelled',
            'PROVIDER_CANCELLED',
            'The model request was cancelled before retry.',
            false,
          );
        }
        return client.createStream(wire, {
          signal: options.signal,
          ...(requestTimeoutMs !== undefined ? { timeoutMs: requestTimeoutMs } : {}),
        });
      }, retryPolicy);

      const toolFragments: Record<string, unknown>[] = [];
      const toolCallIds = new Map<number, string>();
      let finishReason: ModelFinishReason = 'unknown';
      let usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined;

      for await (const chunk of chunks) {
        if (options.signal.aborted) {
          throw providerError(
            'cancelled',
            'PROVIDER_CANCELLED',
            'The model request was cancelled.',
            false,
          );
        }
        if (chunk.usage !== null && chunk.usage !== undefined) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
        const choice = chunk.choices[0];
        if (choice === undefined) {
          continue;
        }
        if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
          yield { type: 'text_delta', delta: choice.delta.content };
        }
        const fragments = choice.delta?.tool_calls;
        if (fragments !== undefined && fragments !== null) {
          for (const fragment of fragments) {
            const index = fragment['index'];
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
              continue;
            }
            const rawId = fragment['id'];
            const callId =
              toolCallIds.get(index) ??
              (typeof rawId === 'string' && rawId.length > 0 ? rawId : `call_${String(index)}`);
            toolCallIds.set(index, callId);
            toolFragments.push({ ...fragment, id: callId });

            const fn = fragment['function'];
            const argumentDelta =
              typeof fn === 'object' &&
              fn !== null &&
              'arguments' in fn &&
              typeof (fn as { arguments?: unknown }).arguments === 'string'
                ? ((fn as { arguments: string }).arguments ?? '')
                : '';
            if (argumentDelta.length > 0) {
              yield { type: 'tool_call_delta', callId, delta: argumentDelta };
            }
          }
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }

      if (usage !== undefined) {
        yield {
          type: 'usage',
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        };
      }

      if (toolFragments.length > 0) {
        for (const call of collectStreamedToolCalls(toolFragments)) {
          yield { type: 'tool_call', call: toModelToolCall(call) };
        }
        if (finishReason === 'unknown') {
          finishReason = 'tool_calls';
        }
      }

      yield { type: 'completed', finishReason };
    }

    async function* guarded(): AsyncGenerator<ModelStreamEvent> {
      try {
        yield* generate();
      } catch (error) {
        throw mapStreamError(error);
      }
    }

    return withStreamFailures(guarded());
  }
}

function withStreamFailures(
  source: AsyncGenerator<ModelStreamEvent>,
): AsyncIterable<ModelStreamEvent> {
  const mapped = (async function* mapStream(): AsyncGenerator<ModelStreamEvent | StreamFailure> {
    try {
      for await (const event of source) {
        yield event;
      }
    } catch (error) {
      yield { __streamFailed: mapStreamError(error) };
    }
  })();
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
      for await (const item of mapped) {
        if (isStreamFailure(item)) {
          throw item.__streamFailed;
        }
        yield item;
      }
    },
  };
}
