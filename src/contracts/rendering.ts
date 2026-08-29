import type { AgentResult } from './agent.js';
import type { EchoEvent } from './events.js';

export interface RenderCapabilities {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly verbose: boolean;
  readonly columns?: number;
}

export type OutputChannel = 'stdout' | 'stderr';

export interface RenderChunk {
  readonly channel: OutputChannel;
  readonly text: string;
}

export interface EventRenderer {
  renderEvent(event: EchoEvent, capabilities: RenderCapabilities): readonly RenderChunk[];

  renderResult(result: AgentResult, capabilities: RenderCapabilities): readonly RenderChunk[];
}
