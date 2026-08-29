import { describe, expect, it } from 'vitest';

import type { ModelRequest, ModelStreamEvent } from '../../../src/contracts/index.js';
import { FakeProvider } from '../../../src/provider/index.js';

const request: ModelRequest = {
  model: 'fake-model',
  messages: [{ role: 'user', content: 'goal' }],
  tools: [],
};

async function collect(provider: FakeProvider, signal = new AbortController().signal) {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(request, { signal })) {
    events.push(event);
  }
  return events;
}

describe('FakeProvider', () => {
  it('consumes deterministic responses in order and records requests', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'first' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      { events: [{ type: 'completed', finishReason: 'tool_calls' }] },
    ]);

    await expect(collect(provider)).resolves.toEqual([
      { type: 'text_delta', delta: 'first' },
      { type: 'completed', finishReason: 'stop' },
    ]);
    await expect(collect(provider)).resolves.toEqual([
      { type: 'completed', finishReason: 'tool_calls' },
    ]);
    expect(provider.requests).toEqual([request, request]);
  });

  it('scripts catalog lists independently from stream responses', async () => {
    const provider = new FakeProvider(
      [{ events: [{ type: 'completed', finishReason: 'stop' }] }],
      'fake',
      [{ ids: ['model-a', 'model-b'] }],
    );

    await expect(provider.listModelIds({ signal: new AbortController().signal })).resolves.toEqual([
      'model-a',
      'model-b',
    ]);
    expect(provider.listModelCallCount).toBe(1);
    expect(provider.requests).toEqual([]);
  });

  it('surfaces a scripted error after prior events', async () => {
    const error = {
      category: 'provider_protocol',
      code: 'SCRIPTED_FAILURE',
      message: 'scripted',
      retryable: false,
    } as const;
    const provider = new FakeProvider([
      { events: [{ type: 'text_delta', delta: 'partial' }], error },
    ]);

    await expect(collect(provider)).rejects.toBe(error);
  });

  it('fails clearly when the script is exhausted', async () => {
    const provider = new FakeProvider([]);
    await expect(collect(provider)).rejects.toMatchObject({
      category: 'provider_protocol',
      code: 'FAKE_PROVIDER_SCRIPT_EXHAUSTED',
    });
  });

  it('honors an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FakeProvider([{ events: [] }]);

    await expect(collect(provider, controller.signal)).rejects.toMatchObject({
      category: 'cancelled',
    });
  });
});
