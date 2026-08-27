import type { ModelProvider, ModelRequest, ModelStreamEvent } from '../contracts/index.js';

import { cancellationError, providerError } from './errors.js';

export interface FakeProviderResponse {
  readonly events: readonly ModelStreamEvent[];
  readonly error?: unknown;
}

/**
 * Deterministic provider for Agent Loop and integration tests. Each stream call
 * consumes exactly one scripted response and records the normalized request.
 */
export class FakeProvider implements ModelProvider {
  readonly name: string;

  private readonly responses: readonly FakeProviderResponse[];
  private readonly recordedRequests: ModelRequest[] = [];
  private responseIndex = 0;

  constructor(responses: readonly FakeProviderResponse[], name = 'fake') {
    this.responses = responses;
    this.name = name;
  }

  get requests(): readonly ModelRequest[] {
    return this.recordedRequests;
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
}
