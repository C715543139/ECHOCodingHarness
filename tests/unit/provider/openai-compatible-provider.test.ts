import { describe, expect, it } from 'vitest';

import type { EchoError, ModelRequest, ModelStreamEvent } from '../../../src/contracts/index.js';
import type { OpenAICompatibleClient } from '../../../src/provider/index.js';
import { OpenAICompatibleProvider } from '../../../src/provider/index.js';

interface Chunk {
  choices: readonly {
    delta?: {
      content?: string | null;
      tool_calls?: readonly Readonly<Record<string, unknown>>[];
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function textChunk(content: string): Chunk {
  return { choices: [{ delta: { content } }] };
}

function toolCallChunk(fragment: Record<string, unknown>): Chunk {
  return { choices: [{ delta: { tool_calls: [fragment] } }] };
}

function finishChunk(reason: string | null): Chunk {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}

function usageChunk(prompt: number, completion: number): Chunk {
  return { choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } };
}

async function unusedListModelIds(): Promise<readonly string[]> {
  throw new Error('listModelIds must not be called during chat completion streaming');
}

function clientFromChunks(
  chunks: readonly Chunk[],
  options: { failFirstWith?: unknown; recordCalls?: Record<string, unknown>[] } = {},
): OpenAICompatibleClient {
  let calls = 0;
  return {
    async createStream(wireRequest, requestOptions) {
      options.recordCalls?.push({
        ...wireRequest,
        signalPresent: requestOptions.signal !== undefined,
      });
      calls += 1;
      if (options.failFirstWith !== undefined && calls === 1) {
        throw options.failFirstWith;
      }
      async function* generate(): AsyncGenerator<Chunk> {
        for (const chunk of chunks) {
          yield chunk;
        }
      }
      return generate();
    },
    listModelIds: unusedListModelIds,
  };
}

const baseRequest: ModelRequest = {
  model: '',
  messages: [{ role: 'user', content: 'goal' }],
  tools: [],
};

async function collectEvents(
  provider: OpenAICompatibleProvider,
  request: ModelRequest = baseRequest,
  signal?: AbortSignal,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(request, {
    signal: signal ?? new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

function makeProvider(
  chunks: readonly Chunk[],
  clientOptions?: Parameters<typeof clientFromChunks>[1],
  retryPolicy = { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    client: clientFromChunks(chunks, clientOptions),
    model: 'default-model',
    retryPolicy,
  });
}

describe('OpenAICompatibleProvider', () => {
  it('emits text deltas followed by a completion event', async () => {
    const provider = makeProvider([textChunk('Hello'), textChunk(' world'), finishChunk('stop')]);
    const events = await collectEvents(provider);

    expect(events).toEqual([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
      { type: 'completed', finishReason: 'stop' },
    ]);
  });

  it('aggregates streamed tool call fragments into a complete tool_call event', async () => {
    const provider = makeProvider([
      toolCallChunk({ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"pa' } }),
      toolCallChunk({ index: 0, function: { arguments: 'th":"src/a.ts"}' } }),
      finishChunk('tool_calls'),
    ]);
    const events = await collectEvents(provider);

    expect(events.slice(0, 2)).toEqual([
      { type: 'tool_call_delta', callId: 'call-1', delta: '{"pa' },
      { type: 'tool_call_delta', callId: 'call-1', delta: 'th":"src/a.ts"}' },
    ]);

    const toolCall = events.find((event) => event.type === 'tool_call');
    expect(toolCall).toEqual({
      type: 'tool_call',
      call: { id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } },
    });
    expect(events[events.length - 1]).toEqual({ type: 'completed', finishReason: 'tool_calls' });
  });

  it('uses one stable fallback id when streamed fragments omit an id', async () => {
    const provider = makeProvider([
      toolCallChunk({ index: 0, function: { name: 'noop', arguments: '{' } }),
      toolCallChunk({ index: 0, id: 'late-id', function: { arguments: '}' } }),
      finishChunk('tool_calls'),
    ]);

    const events = await collectEvents(provider);
    expect(events.filter((event) => event.type === 'tool_call_delta')).toEqual([
      { type: 'tool_call_delta', callId: 'call_0', delta: '{' },
      { type: 'tool_call_delta', callId: 'call_0', delta: '}' },
    ]);
    expect(events).toContainEqual({
      type: 'tool_call',
      call: { id: 'call_0', name: 'noop', arguments: {} },
    });
  });

  it('classifies HTTP authentication and rate-limit failures without leaking secrets', async () => {
    const retryPolicy = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 };
    const auth = new OpenAICompatibleProvider({
      client: clientFromChunks([], {
        failFirstWith: {
          status: 401,
          message: 'Authorization: Bearer sk-supersecretvalue',
        },
      }),
      model: 'm',
      retryPolicy,
    });
    const rateLimited = new OpenAICompatibleProvider({
      client: clientFromChunks([], { failFirstWith: { status: 429, message: 'slow down' } }),
      model: 'm',
      retryPolicy,
    });

    const authError = await collectEvents(auth).catch((error: unknown) => error);
    expect(authError).toMatchObject({ category: 'provider_auth', retryable: false });
    expect(JSON.stringify(authError)).not.toContain('sk-supersecretvalue');
    await expect(collectEvents(rateLimited)).rejects.toMatchObject({
      category: 'provider_rate_limit',
      retryable: true,
    });
  });

  it('emits tool_call events before completed even with an inconsistent finish reason', async () => {
    const provider = makeProvider([
      toolCallChunk({ index: 0, id: 'call-1', function: { name: 'noop', arguments: '{}' } }),
      finishChunk(null),
    ]);
    const events = await collectEvents(provider);

    expect(events.some((event) => event.type === 'tool_call')).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'completed', finishReason: 'tool_calls' });
  });

  it('supports two tool calls in a single response', async () => {
    const provider = makeProvider([
      toolCallChunk({ index: 0, id: 'call-1', function: { name: 'a', arguments: '{}' } }),
      toolCallChunk({ index: 1, id: 'call-2', function: { name: 'b', arguments: '{"x":1}' } }),
      finishChunk('tool_calls'),
    ]);
    const events = await collectEvents(provider);

    const calls = events.filter((event) => event.type === 'tool_call');
    expect(calls.map((call) => (call.type === 'tool_call' ? call.call.name : ''))).toEqual([
      'a',
      'b',
    ]);
  });

  it('emits usage from the trailing usage chunk', async () => {
    const provider = makeProvider([textChunk('hi'), finishChunk('stop'), usageChunk(120, 30)]);
    const events = await collectEvents(provider);

    expect(events).toContainEqual({ type: 'usage', inputTokens: 120, outputTokens: 30 });
    expect(events[events.length - 1]).toEqual({ type: 'completed', finishReason: 'stop' });
  });

  it('sends the configured default model when the request leaves it blank', async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = makeProvider([finishChunk('stop')], { recordCalls: calls });

    await collectEvents(provider);

    expect(calls[0]?.['model']).toBe('default-model');
    expect(calls[0]?.['stream']).toBe(true);
  });

  it('retries a transient network failure and then streams successfully', async () => {
    const transient: EchoError = {
      category: 'provider_network',
      code: 'PROVIDER_STREAM_FAILED',
      message: 'connection reset',
      retryable: true,
    };
    const provider = makeProvider([finishChunk('stop')], { failFirstWith: transient });

    const events = await collectEvents(provider);
    expect(events).toEqual([{ type: 'completed', finishReason: 'stop' }]);
  });

  it('does not retry a non-retryable failure', async () => {
    const authError: EchoError = {
      category: 'provider_auth',
      code: 'PROVIDER_AUTH',
      message: 'invalid api key',
      retryable: false,
    };
    const provider = makeProvider([finishChunk('stop')], { failFirstWith: authError });

    await expect(collectEvents(provider)).rejects.toMatchObject({
      category: 'provider_auth',
      retryable: false,
    });
  });

  it('surfaces errors thrown mid-stream as EchoError rejections', async () => {
    const failing: OpenAICompatibleClient = {
      async createStream() {
        async function* generate(): AsyncGenerator<Chunk> {
          yield textChunk('partial');
          throw new Error('sse connection dropped');
        }
        return generate();
      },
      listModelIds: unusedListModelIds,
    };
    const provider = new OpenAICompatibleProvider({
      client: failing,
      model: 'm',
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
    });

    await expect(collectEvents(provider)).rejects.toMatchObject({
      category: 'provider_network',
      retryable: true,
    });
  });

  it('reports malformed tool call JSON as a protocol error', async () => {
    const provider = makeProvider([
      toolCallChunk({
        index: 0,
        id: 'call-1',
        function: { name: 'read_file', arguments: '{oops' },
      }),
      finishChunk('tool_calls'),
    ]);

    await expect(collectEvents(provider)).rejects.toMatchObject({
      category: 'provider_protocol',
    });
  });

  it('stops early when the abort signal is already triggered', async () => {
    let createStreamCalls = 0;
    const client: OpenAICompatibleClient = {
      async createStream() {
        createStreamCalls += 1;
        async function* generate(): AsyncGenerator<Chunk> {
          yield textChunk('text');
        }
        return generate();
      },
      listModelIds: unusedListModelIds,
    };
    const provider = new OpenAICompatibleProvider({
      client,
      model: 'm',
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(collectEvents(provider, baseRequest, controller.signal)).rejects.toMatchObject({
      category: 'cancelled',
    });
    expect(createStreamCalls).toBe(1);
  });

  it('normalizes unexpected client errors into provider_network', async () => {
    const retryPolicy = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 };
    const failing = new OpenAICompatibleProvider({
      client: clientFromChunks([finishChunk('stop')], { failFirstWith: new Error('boom') }),
      model: 'm',
      retryPolicy,
    });
    await expect(collectEvents(failing)).rejects.toMatchObject({
      category: 'provider_network',
      code: 'PROVIDER_STREAM_FAILED',
    });
  });

  it('delegates catalog listing to the transport client without streaming', async () => {
    let listed = 0;
    const provider = new OpenAICompatibleProvider({
      client: {
        createStream: async () => {
          throw new Error('stream must not run during catalog listing');
        },
        listModelIds: async () => {
          listed += 1;
          return ['alpha', 'beta'];
        },
      },
      model: 'alpha',
      retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(provider.listModelIds({ signal: new AbortController().signal })).resolves.toEqual([
      'alpha',
      'beta',
    ]);
    expect(listed).toBe(1);
  });
});
