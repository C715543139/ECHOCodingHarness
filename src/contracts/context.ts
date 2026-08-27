import type { EchoEvent } from './events.js';
import type { ModelMessage } from './model.js';

export interface ContextBudget {
  readonly maxApproxTokens: number;
  readonly reservedOutputTokens: number;
}

export interface ContextTruncation {
  readonly reason: string;
  readonly originalSize: number;
  readonly keptSize: number;
}

export interface ContextProjection {
  readonly messages: readonly ModelMessage[];
  readonly approximateTokens: number;
  readonly omittedEventCount: number;
  readonly truncations: readonly ContextTruncation[];
}

export interface ContextBuilder {
  build(events: readonly EchoEvent[], budget: ContextBudget): ContextProjection;
}
