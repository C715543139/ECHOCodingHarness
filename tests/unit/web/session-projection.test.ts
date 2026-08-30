import { describe, expect, it } from 'vitest';

import { WEB_JSON_SCHEMAS, validateWebJsonSchema } from '../../../src/contracts/web-schema.js';
import { toQueryView } from '../../../src/session/session-query.js';
import {
  historyGap,
  projectChatTurn,
  projectSessionView,
  sessionPhase,
  sessionTitle,
} from '../../../src/web/session-projection.js';
import type { EchoEvent } from '../../../src/contracts/index.js';

const SESSION_ID = 'session-abc123def456';
const PROVIDER = {
  kind: 'openai-compatible' as const,
  name: 'openai-compatible' as const,
  endpointFingerprint: 'a'.repeat(64),
};

function event(
  sequence: number,
  type: EchoEvent['type'],
  payload: never,
  extra: Partial<EchoEvent> = {},
): EchoEvent {
  return {
    id: `event-${String(sequence)}`,
    sequence,
    timestamp: `2026-08-30T00:00:0${String(sequence)}.000Z`,
    sessionId: SESSION_ID,
    type,
    payload,
    ...extra,
  } as EchoEvent;
}

describe('Session web projection', () => {
  it('titles sessions from the redacted user goal and maps idle versus running phases', () => {
    const events: EchoEvent[] = [
      event(1, 'session.started', {
        workspace: '.',
        safetyMode: 'balanced',
        eventSchemaVersion: 3,
        provider: PROVIDER,
        model: 'fake-model',
      } as never),
      event(2, 'turn.started', { goal: 'Inspect C:\\Users\\alice\\secret' } as never, {
        turnId: 'turn-1',
      }),
    ];
    const view = toQueryView(SESSION_ID, 'workspace', events);
    expect(sessionTitle(view, { workspaceRoot: 'C:\\Users\\alice' })).not.toMatch(/alice/u);
    expect(sessionPhase(view, SESSION_ID, 'turn-1')).toBe('running');
    expect(sessionPhase(view, 'session-other', 'turn-9')).toBe('running');
  });

  it('projects chat turns from aggregated model.text and omits reasoning', () => {
    const events: EchoEvent[] = [
      event(1, 'session.started', {
        workspace: '.',
        safetyMode: 'balanced',
        eventSchemaVersion: 3,
        provider: PROVIDER,
        model: 'fake-model',
      } as never),
      event(2, 'turn.started', { goal: 'summarize' } as never, { turnId: 'turn-1' }),
      event(3, 'step.started', { step: 1 } as never, { turnId: 'turn-1', stepId: 'step-1' }),
      event(4, 'model.text', { text: 'visible answer', partial: true } as never, {
        turnId: 'turn-1',
        stepId: 'step-1',
      }),
      event(5, 'model.reasoning', { type: 'text', text: 'hidden chain' } as never, {
        turnId: 'turn-1',
        stepId: 'step-1',
      }),
      event(
        6,
        'turn.completed',
        {
          result: {
            sessionId: SESSION_ID,
            turnId: 'turn-1',
            status: 'completed',
            stopReason: 'completed',
            steps: 1,
            toolCalls: 0,
          },
        } as never,
        { turnId: 'turn-1' },
      ),
    ];
    const view = toQueryView(SESSION_ID, 'workspace', events);
    const firstTurn = view.turns[0];
    expect(firstTurn).toBeDefined();
    if (firstTurn === undefined) throw new Error('expected a chat turn');
    const chat = projectChatTurn(firstTurn, {});
    expect(chat.userText).toBe('summarize');
    expect(chat.responses).toEqual([{ step: 1, text: 'visible answer', partial: true }]);
    expect(JSON.stringify(chat)).not.toMatch(/hidden chain|reasoning/u);
    expect(chat.status).toBe('completed');

    const projected = projectSessionView(view, {
      capabilities: {
        serviceState: 'running',
        providerAvailable: true,
        selectedSessionAvailable: true,
        awaitingApproval: false,
      },
      redaction: {},
    });
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.sessionView, projected)).toEqual([]);
  });

  it('detects a history gap when the next seq is not contiguous', () => {
    const events: EchoEvent[] = [
      event(1, 'session.started', {
        workspace: '.',
        safetyMode: 'balanced',
        eventSchemaVersion: 3,
        provider: PROVIDER,
        model: 'fake-model',
      } as never),
      event(4, 'session.resumed', {
        eventSchemaVersion: 3,
        provider: PROVIDER,
        model: 'fake-model',
        safetyMode: 'balanced',
        turnCount: 0,
      } as never),
    ];
    expect(historyGap(events, 1)).toBe(true);
    expect(historyGap(events, 4)).toBe(false);
    expect(historyGap(events, 0)).toBe(true);
  });

  it('projects a bound pending approval that validates against the session view schema', () => {
    const events: EchoEvent[] = [
      event(1, 'session.started', {
        workspace: '.',
        safetyMode: 'balanced',
        eventSchemaVersion: 3,
        provider: PROVIDER,
        model: 'fake-model',
      } as never),
      event(2, 'turn.started', { goal: 'inspect the fixture' } as never, { turnId: 'turn-1' }),
      event(
        3,
        'model.tool_call',
        {
          call: { id: 'call-1', name: 'inspect', arguments: { path: 'a' } },
        } as never,
        { turnId: 'turn-1' },
      ),
      event(
        4,
        'approval.requested',
        {
          toolCallId: 'call-1',
          reason: 'confirm test operation',
          approvalKey: 'approval-key',
          policyRuleId: 'policy.test.ask',
        } as never,
        { turnId: 'turn-1' },
      ),
    ];
    const view = toQueryView(SESSION_ID, 'workspace', events);
    const projected = projectSessionView(view, {
      capabilities: {
        serviceState: 'running',
        providerAvailable: true,
        selectedSessionAvailable: true,
        selectedSessionId: SESSION_ID,
        awaitingApproval: true,
        activeSessionId: SESSION_ID,
        activeTurnId: 'turn-1',
      },
      redaction: {},
      activeSessionId: SESSION_ID,
      activeTurnId: 'turn-1',
    });
    expect(projected.session.pendingApproval).toMatchObject({
      sessionId: SESSION_ID,
      turnId: 'turn-1',
      toolCallId: 'call-1',
      approvalKey: 'approval-key',
      allowedChoices: ['deny', 'allow_once', 'allow_session'],
    });
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.sessionView, projected)).toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.sessionViewResponse, {
        data: projected,
        requestId: 'req_0123456789abcd',
      }),
    ).toEqual([]);
  });
});
