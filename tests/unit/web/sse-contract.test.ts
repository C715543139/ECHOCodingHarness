import { describe, expect, it } from 'vitest';

import {
  WEB_STREAM_EVENT_TYPES,
  WEB_TRANSPORT_EVENT_TYPES,
  type WebStreamEvent,
} from '../../../src/contracts/web.js';
import { WEB_JSON_SCHEMAS, isWebStreamEvent } from '../../../src/contracts/web-schema.js';
import { projectRuntimeCapabilities } from '../../../src/web/runtime-capabilities.js';

const requestId = 'req_sse_0123456789';

function idleView() {
  return {
    session: {
      id: 'session-1',
      shortId: 'sess1',
      title: 'Investigate fixture',
      updatedAt: '2026-08-30T00:00:00.000Z',
      turnCount: 1,
      phase: 'running' as const,
      model: 'fake-model',
      safetyMode: 'balanced' as const,
      context: { usedApproxTokens: 120, limitApproxTokens: 256000 },
    },
    capabilities: projectRuntimeCapabilities({
      serviceState: 'running',
      providerAvailable: true,
      selectedSessionAvailable: true,
      selectedSessionId: 'session-1',
      activeSessionId: 'session-1',
      activeTurnId: 'turn-1',
      awaitingApproval: false,
    }),
  };
}

describe('WebStreamEvent discriminated union', () => {
  it('accepts every business SSE branch and rejects heartbeat as a payload', () => {
    const events: readonly WebStreamEvent[] = [
      {
        type: 'session.updated',
        sessionId: 'session-1',
        seq: 2,
        delta: { view: idleView() },
      },
      {
        type: 'record.upsert',
        sessionId: 'session-1',
        seq: 3,
        delta: {
          view: idleView(),
          chatTurn: {
            turnId: 'turn-1',
            startedAt: '2026-08-30T00:00:00.000Z',
            userText: 'inspect the fixture',
            responses: [{ step: 1, text: 'working', partial: true }],
            toolSummaries: [
              {
                toolCallId: 'call-1',
                name: 'read_file',
                status: 'running',
              },
            ],
            status: 'running',
          },
          traceRecords: [
            {
              id: 'rec-1',
              seq: 3,
              turnId: 'turn-1',
              time: '2026-08-30T00:00:01.000Z',
              type: 'agent',
              label: 'Model response',
              status: 'running',
              hasDetails: false,
            },
          ],
        },
      },
      {
        type: 'approval.pending',
        sessionId: 'session-1',
        seq: 4,
        approval: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'call-2',
          toolName: 'run_command',
          approvalKey: 'approval:run_command:fixture',
          actionSummary: 'Install workspace dependencies',
          riskReason: 'Dependency or software changes require approval.',
          allowedChoices: ['deny', 'allow_once', 'allow_session'],
        },
        delta: { view: idleView() },
      },
      {
        type: 'turn.terminal',
        sessionId: 'session-1',
        seq: 5,
        turnId: 'turn-1',
        status: 'completed',
        delta: { view: idleView() },
      },
      {
        type: 'resync.required',
        sessionId: 'session-1',
        lastAvailableSeq: 9,
        reason: 'history_gap',
      },
    ];

    expect(WEB_STREAM_EVENT_TYPES).toEqual([
      'session.updated',
      'record.upsert',
      'approval.pending',
      'turn.terminal',
      'resync.required',
    ]);
    expect(WEB_TRANSPORT_EVENT_TYPES).toEqual(['heartbeat']);
    for (const event of events) {
      expect(isWebStreamEvent(event)).toBe(true);
    }
    expect(
      isWebStreamEvent({
        type: 'heartbeat',
        sessionId: 'session-1',
        seq: 6,
      }),
    ).toBe(false);
    expect(requestId).toMatch(/^[A-Za-z0-9._~-]{16,128}$/u);
  });

  it('rejects a competing payload shape for the same seq type', () => {
    expect(
      isWebStreamEvent({
        type: 'turn.terminal',
        sessionId: 'session-1',
        lastAvailableSeq: 1,
        reason: 'history_gap',
      }),
    ).toBe(false);
    expect(WEB_JSON_SCHEMAS.webStreamEvent.oneOf).toHaveLength(4);
  });
});
