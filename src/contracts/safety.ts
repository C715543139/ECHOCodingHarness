export const SAFETY_MODES = ['safe', 'balanced', 'auto', 'full-access'] as const;
export type SafetyMode = (typeof SAFETY_MODES)[number];

export type PolicyDecision =
  | Readonly<{ action: 'allow'; reason: string; ruleId: string }>
  | Readonly<{ action: 'ask'; reason: string; approvalKey: string; ruleId: string }>
  | Readonly<{ action: 'deny'; reason: string; hard: boolean; ruleId: string }>;

export interface PolicyRequest {
  readonly mode: SafetyMode;
  readonly toolName: string;
  readonly normalizedInput: unknown;
  readonly workspaceRoot: string;
  readonly sessionApprovals: ReadonlySet<string>;
}

export interface SafetyPolicy {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}
