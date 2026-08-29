import type { ModelProvider, ModelRequest, ModelStreamEvent } from '../contracts/index.js';

import { cancellationError, providerError } from './errors.js';

export interface FakeProviderResponse {
  readonly events: readonly ModelStreamEvent[];
  readonly error?: unknown;
}

export interface FakeProviderListResponse {
  readonly ids?: readonly string[];
  readonly error?: unknown;
}

/**
 * Deterministic provider for Agent Loop and integration tests. Each stream call
 * consumes exactly one scripted response and records the normalized request.
 * Catalog listing is optional and is never invoked by `run`.
 */
export class FakeProvider implements ModelProvider {
  readonly name: string;

  private readonly responses: readonly FakeProviderResponse[];
  private readonly listResponses: readonly FakeProviderListResponse[];
  private readonly recordedRequests: ModelRequest[] = [];
  private responseIndex = 0;
  private listIndex = 0;
  private listCalls = 0;

  constructor(
    responses: readonly FakeProviderResponse[],
    name = 'fake',
    listResponses: readonly FakeProviderListResponse[] = [],
  ) {
    this.responses = responses;
    this.name = name;
    this.listResponses = listResponses;
  }

  get requests(): readonly ModelRequest[] {
    return this.recordedRequests;
  }

  get listModelCallCount(): number {
    return this.listCalls;
  }

  stream(
    request: ModelRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<ModelStreamEvent> {
    const response = this.responses[this.responseIndex];
    this.responseIndex += 1;
    this.recordedRequests.push(request);

    async function* generate(): AsyncGenerator<ModelStreamEvent> {
      if (options.signal.aborted) {
        throw cancellationError('The fake model request was cancelled.');
      }
      if (response === undefined) {
        throw providerError(
          'provider_protocol',
          'FAKE_PROVIDER_SCRIPT_EXHAUSTED',
          'The Fake Provider has no scripted response for this request.',
          false,
        );
      }
      for (const event of response.events) {
        if (options.signal.aborted) {
          throw cancellationError('The fake model request was cancelled.');
        }
        yield event;
      }
      if (response.error !== undefined) {
        throw response.error;
      }
    }

    return generate();
  }

  async listModelIds(
    options: Readonly<{ signal: AbortSignal; timeoutMs?: number }>,
  ): Promise<readonly string[]> {
    this.listCalls += 1;
    if (options.signal.aborted) {
      throw cancellationError('The fake model catalog request was cancelled.');
    }
    const response = this.listResponses[this.listIndex];
    this.listIndex += 1;
    if (response === undefined) {
      throw providerError(
        'provider_protocol',
        'FAKE_PROVIDER_SCRIPT_EXHAUSTED',
        'The Fake Provider has no scripted model list for this request.',
        false,
      );
    }
    if (response.error !== undefined) {
      throw response.error;
    }
    return response.ids ?? [];
  }
}
