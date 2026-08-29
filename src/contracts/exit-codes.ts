import type { AgentResult } from './agent.js';

export const CLI_EXIT_CODES = {
  success: 0,
  unclassified: 1,
  usageOrConfig: 2,
  provider: 3,
  tool: 4,
  policy: 5,
  limit: 6,
  cancelled: 130,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export function exitCodeForAgentResult(result: AgentResult): CliExitCode {
  if (result.status === 'completed') return CLI_EXIT_CODES.success;
  if (result.status === 'cancelled' || result.stopReason === 'cancelled') {
    return CLI_EXIT_CODES.cancelled;
  }
  if (result.status === 'limited') return CLI_EXIT_CODES.limit;
  if (result.stopReason === 'provider_error') return CLI_EXIT_CODES.provider;
  if (result.stopReason === 'tool_error') return CLI_EXIT_CODES.tool;
  if (result.stopReason === 'policy_denied') return CLI_EXIT_CODES.policy;
  return CLI_EXIT_CODES.unclassified;
}
