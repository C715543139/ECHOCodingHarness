import type { EchoError } from './errors.js';
import type { SessionId, TurnId } from './identifiers.js';

export type AgentStopReason =
  | 'completed'
  | 'max_steps'
  | 'repeated_tool_call'
  | 'output_limit'
  | 'policy_denied'
  | 'provider_error'
  | 'tool_error'
  | 'cancelled';

export type AgentStatus = 'completed' | 'failed' | 'cancelled' | 'limited';

export interface AgentResult {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly status: AgentStatus;
  readonly stopReason: AgentStopReason;
  readonly finalText?: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly error?: EchoError;
  readonly verification?: Readonly<{ command: string; exitCode: number }>;
}
