import { describe, expect, it } from 'vitest';

import {
  hasStreamingResponse,
  projectChatTurns,
  upsertChatTurn,
} from '../../../src/web/client/view-model/chat-projection.js';
import { createSampleChatTurn } from '../../../src/web/client/transport/fake-transport.js';

describe('Chat projection', () => {
  it('restores only aggregated model.text fields from Session facts', () => {
    const projected = projectChatTurns([
      createSampleChatTurn({
        responses: [{ step: 1, text: '已聚合的模型正文。', partial: false }],
      }),
    ]);

    expect(projected).toHaveLength(1);
    expect(projected[0]?.responses[0]?.text).toBe('已聚合的模型正文。');
    expect(JSON.stringify(projected)).not.toMatch(/reasoning|sk-[A-Za-z0-9]|ECHO_API_KEY/);
  });

  it('upserts a streaming turn onto a stable record id', () => {
    const first = createSampleChatTurn({
      turnId: 'turn_live',
      status: 'running',
      responses: [{ step: 1, text: 'Hel', partial: true }],
    });
    const second = createSampleChatTurn({
      turnId: 'turn_live',
      status: 'running',
      responses: [{ step: 1, text: 'Hello', partial: true }],
    });
    const upserted = upsertChatTurn(upsertChatTurn([], first), second);

    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.turnId).toBe('turn_live');
    expect(upserted[0]?.responses[0]?.text).toBe('Hello');
    const live = upserted[0];
    expect(live).toBeDefined();
    if (live === undefined) {
      return;
    }
    expect(hasStreamingResponse(live)).toBe(true);
  });
});
