import type { EchoEvent } from '../contracts/events.js';
import type { PolicyDecision } from '../contracts/safety.js';

export const LEGACY_POLICY_EXPLAIN_MARKER = 'legacy_unrecorded' as const;

export type PolicyExplainAction = PolicyDecision['action'];

export type PolicyExplainDecision =
  | {
      readonly availability: 'recorded';
      readonly action: PolicyExplainAction;
      readonly ruleId: string;
      readonly reason: string;
      readonly hard?: boolean;
    }
  | {
      readonly availability: 'legacy_unrecorded';
      readonly marker: typeof LEGACY_POLICY_EXPLAIN_MARKER;
    };

export type PolicyApprovalStatus =
  'not_required' | 'pending' | 'allowed_once' | 'allowed_session' | 'denied' | 'failed';

export type PolicyExecutionStatus =
  'not_started' | 'authorized' | 'running' | 'completed' | 'failed' | 'denied' | 'cancelled';

export interface PolicyExplainFact {
  readonly policy: PolicyExplainDecision;
  readonly approval: PolicyApprovalStatus;
  readonly execution: PolicyExecutionStatus;
}

function toolCallIdOf(event: EchoEvent): string | undefined {
  switch (event.type) {
    case 'approval.requested':
    case 'approval.granted':
    case 'approval.denied':
    case 'tool.authorized':
    case 'tool.started':
      return event.payload.toolCallId;
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.denied':
    case 'tool.cancelled':
      return event.payload.result.toolCallId;
    default:
      return undefined;
  }
}

function relatedEvents(events: readonly EchoEvent[], toolCallId: string): EchoEvent[] {
  return events.filter((event) => toolCallIdOf(event) === toolCallId);
}

function recordedDecision(
  action: PolicyExplainAction,
  ruleId: string | undefined,
  reason: string | undefined,
  hard?: boolean,
): PolicyExplainDecision {
  if (ruleId === undefined || ruleId.length === 0) {
    return { availability: 'legacy_unrecorded', marker: LEGACY_POLICY_EXPLAIN_MARKER };
  }
  return {
    availability: 'recorded',
    action,
    ruleId,
    reason: reason ?? '',
    ...(hard === undefined ? {} : { hard }),
  };
}

function policyFromEvents(related: readonly EchoEvent[]): PolicyExplainDecision {
  const requested = related.find((event) => event.type === 'approval.requested');
  if (requested?.type === 'approval.requested') {
    return recordedDecision('ask', requested.payload.policyRuleId, requested.payload.reason);
  }

  const authorized = related.find(
    (event) => event.type === 'tool.authorized' && event.payload.source === 'policy',
  );
  if (authorized?.type === 'tool.authorized') {
    return recordedDecision('allow', authorized.payload.policyRuleId, authorized.payload.reason);
  }

  const denied = related.find((event) => event.type === 'tool.denied');
  if (denied?.type === 'tool.denied') {
    return recordedDecision(
      'deny',
      denied.payload.policyRuleId,
      denied.payload.result.summary,
      denied.payload.hard,
    );
  }

  return { availability: 'legacy_unrecorded', marker: LEGACY_POLICY_EXPLAIN_MARKER };
}

function approvalFromEvents(related: readonly EchoEvent[]): PolicyApprovalStatus {
  const requested = related.some((event) => event.type === 'approval.requested');
  const granted = related.find((event) => event.type === 'approval.granted');
  const denied = related.find((event) => event.type === 'approval.denied');

  if (!requested && granted === undefined && denied === undefined) {
    return 'not_required';
  }
  if (granted?.type === 'approval.granted') {
    return granted.payload.scope === 'session' ? 'allowed_session' : 'allowed_once';
  }
  if (denied?.type === 'approval.denied') {
    return denied.payload.outcome === 'failed' ? 'failed' : 'denied';
  }
  return requested ? 'pending' : 'not_required';
}

function executionFromEvents(related: readonly EchoEvent[]): PolicyExecutionStatus {
  let status: PolicyExecutionStatus = 'not_started';
  for (const event of related) {
    switch (event.type) {
      case 'tool.authorized':
        status = 'authorized';
        break;
      case 'tool.started':
        status = 'running';
        break;
      case 'tool.completed':
        status = 'completed';
        break;
      case 'tool.failed':
        status = 'failed';
        break;
      case 'tool.denied':
        status = 'denied';
        break;
      case 'tool.cancelled':
        status = 'cancelled';
        break;
      default:
        break;
    }
  }
  return status;
}

export function policyExplainForToolCall(
  events: readonly EchoEvent[],
  toolCallId: string,
): PolicyExplainFact | undefined {
  const related = relatedEvents(events, toolCallId);
  if (related.length === 0) return undefined;
  return {
    policy: policyFromEvents(related),
    approval: approvalFromEvents(related),
    execution: executionFromEvents(related),
  };
}
