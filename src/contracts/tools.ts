import type { EchoError } from './errors.js';
import type { SessionId, StepId, ToolCallId, TurnId } from './identifiers.js';

export interface ToolDefinition<TInput, TData = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;

  execute(input: TInput, context: ToolContext): Promise<ToolExecution<TData>>;
}

export interface ToolContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly toolCallId: ToolCallId;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  readonly limits: ToolLimits;
}

export interface ToolLimits {
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
}

export type ToolExecution<TData> =
  | Readonly<{
      status: 'completed';
      summary: string;
      data: TData;
      truncated: boolean;
    }>
  | Readonly<{
      status: 'failed';
      summary: string;
      error: EchoError;
      truncated: boolean;
    }>;

export type ToolTerminalStatus = 'completed' | 'failed' | 'denied' | 'cancelled';

export interface ToolResultMessage<TStatus extends ToolTerminalStatus = ToolTerminalStatus> {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly status: TStatus;
  readonly summary: string;
  readonly content?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  readonly truncated?: boolean;
}
