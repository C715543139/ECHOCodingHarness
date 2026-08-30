import { describe, expect, it } from 'vitest';

import type { EchoEvent, EchoEventOf, EchoEventType } from '../../../src/contracts/index.js';
import { EVENT_SCHEMA_VERSION } from '../../../src/contracts/index.js';
import {
  CentralSafetyPolicy,
  POLICY_RULE_IDS,
} from '../../../src/security/central-safety-policy.js';
import { createProviderIdentity } from '../../../src/session/index.js';
import {
  LEGACY_POLICY_EXPLAIN_MARKER,
  policyExplainForToolCall,
} from '../../../src/session/policy-explain.js';
import { assertRecoverableEvents } from '../../../src/session/session-query.js';

const workspaceRoot = 'C:\\workspace\\echo-fixture';
const provider = createProviderIdentity('https://provider.example/v1');

function event<TType extends EchoEventType>(
  type: TType,
  payload: EchoEventOf<TType>['payload'],
  extra: Partial<Pick<EchoEvent, 'id' | 'sequence'>> = {},
): EchoEventOf<TType> {
  return {
    id: extra.id ?? `event-${type}`,
    sequence: extra.sequence ?? 1,
    timestamp: '2026-08-30T00:00:00.000Z',
    sessionId: 'session-policy',
    turnId: 'turn-1',
    stepId: 'step-1',
    type,
    payload,
  };
}

function started(): EchoEvent {
  return {
    id: 'event-started',
    sequence: 1,
    timestamp: '2026-08-30T00:00:00.000Z',
    sessionId: 'session-policy',
    type: 'session.started',
    payload: {
      workspace: '.',
      safetyMode: 'balanced',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      provider,
      model: 'fake-model',
    },
  };
}

describe('Policy Explain facts', () => {
  it('assigns a stable ruleId to every PolicyDecision branch', async () => {
    const policy = new CentralSafetyPolicy();
    const deny = await policy.evaluate({
      mode: 'balanced',
      toolName: 'run_command',
      normalizedInput: { command: 'Get-ChildItem Env:' },
      workspaceRoot,
      sessionApprovals: new Set(),
    });
    const ask = await policy.evaluate({
      mode: 'balanced',
      toolName: 'run_command',
      normalizedInput: { command: 'pnpm install' },
      workspaceRoot,
      sessionApprovals: new Set(),
    });
    const allow = await policy.evaluate({
      mode: 'balanced',
      toolName: 'read_file',
      normalizedInput: { path: 'src/index.ts' },
      workspaceRoot,
      sessionApprovals: new Set(),
    });

    expect(deny).toEqual({
      action: 'deny',
      hard: true,
      reason: 'Credential access or environment export is forbidden.',
      ruleId: POLICY_RULE_IDS.commandCredential,
    });
    expect(ask).toMatchObject({
      action: 'ask',
      ruleId: POLICY_RULE_IDS.commandDependency,
    });
    expect(allow).toEqual({
      action: 'allow',
      reason: 'Workspace-scoped read operation.',
      ruleId: POLICY_RULE_IDS.toolReadWorkspace,
    });
  });

  it('keeps PolicyDecision reasons free of workspace paths, homes, and secrets', async () => {
    const policy = new CentralSafetyPolicy();
    const decisions = await Promise.all([
      policy.evaluate({
        mode: 'auto',
        toolName: 'run_command',
        normalizedInput: { command: String.raw`Get-Content C:\Users\fixture\outside.txt` },
        workspaceRoot,
        sessionApprovals: new Set(),
      }),
      policy.evaluate({
        mode: 'auto',
        toolName: 'run_command',
        normalizedInput: { command: '[Console]::Write($env:ECHO_API_KEY)' },
        workspaceRoot,
        sessionApprovals: new Set(),
      }),
    ]);

    for (const decision of decisions) {
      expect(decision.reason).not.toContain(workspaceRoot);
      expect(decision.reason).not.toMatch(/C:\\Users\\/iu);
      expect(decision.reason).not.toContain('ECHO_API_KEY');
      expect(decision.ruleId.startsWith('policy.')).toBe(true);
    }
  });

  it('reads a hard deny as policy deny with approval not required', () => {
    expect(
      policyExplainForToolCall(
        [
          event('tool.denied', {
            result: {
              toolCallId: 'call-new',
              toolName: 'run_command',
              status: 'denied',
              summary: 'Credential access or environment export is forbidden.',
            },
            hard: true,
            policyRuleId: POLICY_RULE_IDS.commandCredential,
          }),
        ],
        'call-new',
      ),
    ).toEqual({
      policy: {
        availability: 'recorded',
        action: 'deny',
        ruleId: POLICY_RULE_IDS.commandCredential,
        reason: 'Credential access or environment export is forbidden.',
        hard: true,
      },
      approval: 'not_required',
      execution: 'denied',
    });
  });

  it('reads a direct allow without rewriting approval or execution layers', () => {
    expect(
      policyExplainForToolCall(
        [
          event('tool.authorized', {
            toolCallId: 'call-allow',
            source: 'policy',
            policyRuleId: POLICY_RULE_IDS.toolReadWorkspace,
            reason: 'Workspace-scoped read operation.',
          }),
          event('tool.started', { toolCallId: 'call-allow', toolName: 'read_file' }),
          event('tool.completed', {
            result: {
              toolCallId: 'call-allow',
              toolName: 'read_file',
              status: 'completed',
              summary: 'ok',
            },
            durationMs: 4,
          }),
        ],
        'call-allow',
      ),
    ).toEqual({
      policy: {
        availability: 'recorded',
        action: 'allow',
        ruleId: POLICY_RULE_IDS.toolReadWorkspace,
        reason: 'Workspace-scoped read operation.',
      },
      approval: 'not_required',
      execution: 'completed',
    });
  });

  it('keeps action=ask while approval is pending', () => {
    expect(
      policyExplainForToolCall(
        [
          event('approval.requested', {
            toolCallId: 'call-ask',
            reason: 'Dependency or software changes require approval.',
            approvalKey: 'approval:run_command:fixture',
            policyRuleId: POLICY_RULE_IDS.commandDependency,
          }),
        ],
        'call-ask',
      ),
    ).toEqual({
      policy: {
        availability: 'recorded',
        action: 'ask',
        ruleId: POLICY_RULE_IDS.commandDependency,
        reason: 'Dependency or software changes require approval.',
      },
      approval: 'pending',
      execution: 'not_started',
    });
  });

  it('keeps action=ask after allow once and allow session', () => {
    const requested = event('approval.requested', {
      toolCallId: 'call-ask',
      reason: 'Dependency or software changes require approval.',
      approvalKey: 'approval:run_command:fixture',
      policyRuleId: POLICY_RULE_IDS.commandDependency,
    });
    expect(
      policyExplainForToolCall(
        [
          requested,
          event('approval.granted', {
            toolCallId: 'call-ask',
            approvalKey: 'approval:run_command:fixture',
            scope: 'once',
          }),
          event('tool.authorized', { toolCallId: 'call-ask', source: 'approval' }),
        ],
        'call-ask',
      ),
    ).toEqual({
      policy: {
        availability: 'recorded',
        action: 'ask',
        ruleId: POLICY_RULE_IDS.commandDependency,
        reason: 'Dependency or software changes require approval.',
      },
      approval: 'allowed_once',
      execution: 'authorized',
    });
    expect(
      policyExplainForToolCall(
        [
          requested,
          event('approval.granted', {
            toolCallId: 'call-ask',
            approvalKey: 'approval:run_command:fixture',
            scope: 'session',
          }),
          event('tool.authorized', { toolCallId: 'call-ask', source: 'approval' }),
        ],
        'call-ask',
      ),
    ).toMatchObject({
      policy: { action: 'ask', ruleId: POLICY_RULE_IDS.commandDependency },
      approval: 'allowed_session',
      execution: 'authorized',
    });
  });

  it('keeps action=ask after a user deny and after approval handler failure', () => {
    const requested = event('approval.requested', {
      toolCallId: 'call-ask',
      reason: 'Dependency or software changes require approval.',
      approvalKey: 'approval:run_command:fixture',
      policyRuleId: POLICY_RULE_IDS.commandDependency,
    });
    expect(
      policyExplainForToolCall(
        [
          requested,
          event('approval.denied', {
            toolCallId: 'call-ask',
            reason: 'The user denied this operation.',
          }),
          event('tool.denied', {
            result: {
              toolCallId: 'call-ask',
              toolName: 'run_command',
              status: 'denied',
              summary: 'The user denied this operation.',
            },
            hard: false,
          }),
        ],
        'call-ask',
      ),
    ).toEqual({
      policy: {
        availability: 'recorded',
        action: 'ask',
        ruleId: POLICY_RULE_IDS.commandDependency,
        reason: 'Dependency or software changes require approval.',
      },
      approval: 'denied',
      execution: 'denied',
    });
    expect(
      policyExplainForToolCall(
        [
          requested,
          event('approval.denied', {
            toolCallId: 'call-ask',
            reason: 'The approval request could not be completed.',
            outcome: 'failed',
          }),
          event('tool.denied', {
            result: {
              toolCallId: 'call-ask',
              toolName: 'run_command',
              status: 'denied',
              summary: 'The approval request could not be completed.',
            },
            hard: false,
          }),
        ],
        'call-ask',
      ),
    ).toEqual({
      policy: {
        availability: 'recorded',
        action: 'ask',
        ruleId: POLICY_RULE_IDS.commandDependency,
        reason: 'Dependency or software changes require approval.',
      },
      approval: 'failed',
      execution: 'denied',
    });
  });

  it('marks missing rule IDs as legacy without inventing a policy action', () => {
    expect(
      policyExplainForToolCall(
        [
          event('tool.denied', {
            result: {
              toolCallId: 'call-old',
              toolName: 'run_command',
              status: 'denied',
              summary: 'forbidden',
            },
            hard: true,
          }),
        ],
        'call-old',
      ),
    ).toEqual({
      policy: {
        availability: 'legacy_unrecorded',
        marker: LEGACY_POLICY_EXPLAIN_MARKER,
      },
      approval: 'not_required',
      execution: 'denied',
    });
    expect(
      policyExplainForToolCall(
        [
          event('tool.authorized', {
            toolCallId: 'call-allow-old',
            source: 'policy',
          }),
        ],
        'call-allow-old',
      ),
    ).toEqual({
      policy: {
        availability: 'legacy_unrecorded',
        marker: LEGACY_POLICY_EXPLAIN_MARKER,
      },
      approval: 'not_required',
      execution: 'authorized',
    });
    expect(
      policyExplainForToolCall(
        [
          event('approval.requested', {
            toolCallId: 'call-ask-old',
            reason: 'confirm',
            approvalKey: 'approval:run_command:legacy',
          }),
        ],
        'call-ask-old',
      ),
    ).toEqual({
      policy: {
        availability: 'legacy_unrecorded',
        marker: LEGACY_POLICY_EXPLAIN_MARKER,
      },
      approval: 'pending',
      execution: 'not_started',
    });
    expect(policyExplainForToolCall([], 'missing')).toBeUndefined();
    expect(
      policyExplainForToolCall(
        [
          event('approval.denied', {
            toolCallId: 'call-user-deny',
            reason: 'The user denied this operation.',
          }),
        ],
        'call-user-deny',
      ),
    ).toEqual({
      policy: {
        availability: 'legacy_unrecorded',
        marker: LEGACY_POLICY_EXPLAIN_MARKER,
      },
      approval: 'denied',
      execution: 'not_started',
    });
  });

  it('classifies localized handler failure by outcome, not by reason text', () => {
    expect(
      policyExplainForToolCall(
        [
          event('approval.requested', {
            toolCallId: 'call-ask',
            reason: 'Dependency or software changes require approval.',
            approvalKey: 'approval:run_command:fixture',
            policyRuleId: POLICY_RULE_IDS.commandDependency,
          }),
          event('approval.denied', {
            toolCallId: 'call-ask',
            reason: 'Approval backend unavailable.',
            outcome: 'failed',
          }),
          event('tool.denied', {
            result: {
              toolCallId: 'call-ask',
              toolName: 'run_command',
              status: 'denied',
              summary: 'Approval backend unavailable.',
            },
            hard: false,
          }),
        ],
        'call-ask',
      ),
    ).toMatchObject({
      policy: { action: 'ask' },
      approval: 'failed',
      execution: 'denied',
    });
  });

  it('does not treat the legacy failure sentence as failed when outcome is denied', () => {
    expect(
      policyExplainForToolCall(
        [
          event('approval.requested', {
            toolCallId: 'call-ask',
            reason: 'Dependency or software changes require approval.',
            approvalKey: 'approval:run_command:fixture',
            policyRuleId: POLICY_RULE_IDS.commandDependency,
          }),
          event('approval.denied', {
            toolCallId: 'call-ask',
            reason: 'The approval request could not be completed.',
            outcome: 'denied',
          }),
          event('tool.denied', {
            result: {
              toolCallId: 'call-ask',
              toolName: 'run_command',
              status: 'denied',
              summary: 'The approval request could not be completed.',
            },
            hard: false,
          }),
        ],
        'call-ask',
      ),
    ).toMatchObject({
      policy: { action: 'ask' },
      approval: 'denied',
      execution: 'denied',
    });
  });

  it('reads a legacy approval.denied without outcome as denied', () => {
    const events = [
      started(),
      event(
        'approval.requested',
        {
          toolCallId: 'call-legacy-deny',
          reason: 'confirm',
          approvalKey: 'approval:run_command:legacy',
        },
        { id: 'event-ask', sequence: 2 },
      ),
      event(
        'approval.denied',
        {
          toolCallId: 'call-legacy-deny',
          reason: 'The approval request could not be completed.',
        },
        { id: 'event-denied', sequence: 3 },
      ),
      event(
        'tool.denied',
        {
          result: {
            toolCallId: 'call-legacy-deny',
            toolName: 'run_command',
            status: 'denied',
            summary: 'The approval request could not be completed.',
          },
          hard: false,
        },
        { id: 'event-tool-denied', sequence: 4 },
      ),
    ];
    expect(() => assertRecoverableEvents(events)).not.toThrow();
    expect(policyExplainForToolCall(events, 'call-legacy-deny')).toEqual({
      policy: {
        availability: 'legacy_unrecorded',
        marker: LEGACY_POLICY_EXPLAIN_MARKER,
      },
      approval: 'denied',
      execution: 'denied',
    });
  });

  it('keeps old Sessions readable when policy explain fields are absent', () => {
    const events = [
      started(),
      event(
        'approval.requested',
        {
          toolCallId: 'call-old',
          reason: 'confirm',
          approvalKey: 'approval:run_command:legacy',
        },
        { id: 'event-ask', sequence: 2 },
      ),
      event(
        'tool.authorized',
        { toolCallId: 'call-old', source: 'approval' },
        { id: 'event-auth', sequence: 3 },
      ),
    ];
    expect(() => assertRecoverableEvents(events)).not.toThrow();
    expect(policyExplainForToolCall(events, 'call-old')).toEqual({
      policy: {
        availability: 'legacy_unrecorded',
        marker: LEGACY_POLICY_EXPLAIN_MARKER,
      },
      approval: 'pending',
      execution: 'authorized',
    });
  });
});
