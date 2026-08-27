export type EchoErrorCategory =
  | 'configuration'
  | 'provider_auth'
  | 'provider_rate_limit'
  | 'provider_network'
  | 'provider_protocol'
  | 'invalid_tool_input'
  | 'workspace_violation'
  | 'policy_denied'
  | 'tool_timeout'
  | 'tool_execution'
  | 'storage'
  | 'cancelled'
  | 'internal';

export interface EchoError {
  readonly category: EchoErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  /** Process-local diagnostic context. It must not be persisted or exposed to the model. */
  readonly cause?: unknown;
}
