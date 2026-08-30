import { describe, expect, it } from 'vitest';

import {
  createWebApprovalFakeProvider,
  createWebChatFakeProvider,
  createWebScenarioTransport,
  WEB_SCENARIO_NAMES,
} from '../../web-fixtures/fake-provider-web-scenarios.js';
import { P2_B4_PENDING_WIRING } from '../../web-fixtures/pending-wiring.js';
import { findWebPrivacyLeaks, serializedWebValue } from '../../web-fixtures/web-privacy.js';

const request = {
  model: 'fake-model',
  messages: [{ role: 'user' as const, content: 'goal' }],
  tools: [],
};

async function collect(provider: ReturnType<typeof createWebChatFakeProvider>) {
  const events = [];
  for await (const event of provider.stream(request, { signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

describe('Fake Provider Web scenarios', () => {
  it('builds every named console fixture without secrets, paths, or reasoning', () => {
    for (const name of WEB_SCENARIO_NAMES) {
      const snapshot = createWebScenarioTransport(name).getSnapshot();
      const leaks = findWebPrivacyLeaks(serializedWebValue(snapshot));
      expect(leaks).toEqual([]);
      expect(snapshot.bootstrap.workspace.name).toBe('echo-harness');
      expect(snapshot.bootstrap.provider.apiKeyConfigured).toBe(true);
      expect(JSON.stringify(snapshot.bootstrap.provider)).not.toMatch(/sk-|apiKey[^C]/u);
    }
  });

  it('scripts a completed Fake Provider Turn and an approval tool-call without paid I/O', async () => {
    const chat = createWebChatFakeProvider();
    await expect(collect(chat)).resolves.toEqual([
      { type: 'text_delta', delta: 'Fake Provider 已接受该 Turn。' },
      { type: 'completed', finishReason: 'stop' },
    ]);

    const approval = createWebApprovalFakeProvider();
    const events = await collect(approval);
    expect(events[0]).toMatchObject({
      type: 'tool_call',
      call: { id: 'call_ask_1', name: 'run_command' },
    });
    expect(findWebPrivacyLeaks(serializedWebValue(events))).toEqual([]);
    expect(process.env.ECHO_RUN_PROVIDER_SMOKE).not.toBe('1');
  });

  it('keeps the approval scenario as DTO state until B2 renders action buttons', () => {
    const snapshot = createWebScenarioTransport('approval').getSnapshot();
    expect(snapshot.chatTurns[0]?.toolSummaries[0]?.status).toBe('awaiting_approval');
    expect(snapshot.traceRecords.some((record) => record.type === 'approval')).toBe(true);
    expect(snapshot.bootstrap.capabilities.canRespondToApproval).toBe(false);
    expect(P2_B4_PENDING_WIRING.some((item) => item.id === 'chat-approval-actions')).toBe(true);
  });

  it('disconnects without offering submit, and large Trace stays within the frozen cap', () => {
    const disconnected = createWebScenarioTransport('disconnected').getSnapshot();
    expect(disconnected.connection).toBe('disconnected');
    expect(disconnected.bootstrap.capabilities.canSubmitTurn).toBe(false);
    expect(disconnected.bootstrap.capabilities.submitTurnBlockedReason).toBe(
      'provider_unavailable',
    );

    const large = createWebScenarioTransport('large-trace').getSnapshot();
    expect(large.traceRecords).toHaveLength(200);
    expect(large.view).toBe('trace');
    expect(large.traceRecords.some((record) => record.type === 'approval')).toBe(true);
  });
});
