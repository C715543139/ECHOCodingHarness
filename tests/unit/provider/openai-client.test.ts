import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  constructorOptions: vi.fn(),
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  OpenAI: class {
    readonly chat = { completions: { create: mocks.create } };

    constructor(options: unknown) {
      mocks.constructorOptions(options);
    }
  },
}));

import { createOpenAIClient } from '../../../src/provider/openai-client.js';

describe('createOpenAIClient', () => {
  beforeEach(() => {
    mocks.constructorOptions.mockReset();
    mocks.create.mockReset();
  });

  it('configures the official client without SDK retries and forwards request boundaries', async () => {
    const wireChunk = {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: { content: 'hello' },
          finish_reason: null,
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
    mocks.create.mockResolvedValue(
      (async function* stream() {
        yield wireChunk;
      })(),
    );
    const client = createOpenAIClient({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-only-key',
      timeoutMs: 10_000,
    });
    const controller = new AbortController();

    const stream = await client.createStream(
      { model: 'test-model', messages: [], stream: true },
      { signal: controller.signal, timeoutMs: 2_000 },
    );
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(mocks.constructorOptions).toHaveBeenCalledWith({
      baseURL: 'https://provider.example/v1',
      apiKey: 'test-only-key',
      maxRetries: 0,
      timeout: 10_000,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      { model: 'test-model', messages: [], stream: true },
      { signal: controller.signal, timeout: 2_000 },
    );
    expect(chunks).toEqual([
      {
        choices: [{ delta: { content: 'hello', tool_calls: undefined }, finish_reason: null }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      },
    ]);
  });

  it('normalizes tool-call chunks without exposing the SDK response object', async () => {
    mocks.create.mockResolvedValue(
      (async function* stream() {
        yield {
          id: 'chunk-2',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        };
      })(),
    );
    const client = createOpenAIClient({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-only-key',
    });

    const stream = await client.createStream(
      { model: 'test-model', messages: [], stream: true },
      { signal: new AbortController().signal },
    );
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks[0]?.choices[0]?.delta?.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: 'call-1',
      function: { name: 'read_file', arguments: '{}' },
    });
    expect(chunks[0]).not.toHaveProperty('id');
  });
});
