import { describe, expect, it } from 'vitest';

import type {
  ContextBudget,
  EchoEvent,
  EchoEventOf,
  ModelMessage,
  ToolResultMessage,
  ToolTerminalStatus,
} from '../../../src/contracts/index.js';
import { EventContextBuilder } from '../../../src/context/event-context-builder.js';

let sequence = 0;

function event<TType extends EchoEvent['type']>(
  type: TType,
  payload: EchoEventOf<TType>['payload'],
): EchoEventOf<TType> {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    sequence,
    timestamp: '2026-08-27T00:00:00.000Z',
    sessionId: 'session-1',
    turnId: 'turn-1',
    stepId: 'step-1',
    type,
    payload,
  };
}

function toolResult<TStatus extends ToolTerminalStatus>(
  status: TStatus,
  content: string,
  toolCallId = 'call-1',
  toolName = 'read_file',
): ToolResultMessage<TStatus> {
  return {
    toolCallId,
    toolName,
    status,
    summary: content.slice(0, 20),
    ...(status === 'completed' ? { content } : {}),
  } as ToolResultMessage<TStatus>;
}

const largeBudget: ContextBudget = { maxApproxTokens: 100_000, reservedOutputTokens: 4_000 };

function simpleHistory(): EchoEvent[] {
  return [
    event('session.started', { workspace: 'F:\\repo', safetyMode: 'balanced' }),
    event('turn.started', { goal: 'Fix the failing tests' }),
    event('step.started', { step: 1 }),
    event('model.text_delta', { delta: 'Let me look at the file.' }),
    event('model.tool_call', {
      call: { id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } },
    }),
    event('tool.completed', {
      result: toolResult('completed', 'file contents here'),
      durationMs: 3,
    }),
  ];
}

describe('EventContextBuilder', () => {
  it('keeps system prompt and goal, then projects the latest assistant/tool exchange', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM CONSTRAINTS' });
    const projection = builder.build(simpleHistory(), largeBudget);

    expect(projection.messages[0]).toEqual({ role: 'system', content: 'SYSTEM CONSTRAINTS' });
    expect(projection.messages[1]).toEqual({ role: 'user', content: 'Fix the failing tests' });
    expect(projection.messages).toEqual([
      { role: 'system', content: 'SYSTEM CONSTRAINTS' },
      { role: 'user', content: 'Fix the failing tests' },
      {
        role: 'assistant',
        content: 'Let me look at the file.',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } }],
      },
      { role: 'tool', toolCallId: 'call-1', content: '[completed] file contents here' },
    ]);
    expect(projection.omittedEventCount).toBe(0);
    expect(projection.truncations).toEqual([]);
  });

  it('reports a positive approximate token estimate', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM CONSTRAINTS' });
    const projection = builder.build(simpleHistory(), largeBudget);
    expect(projection.approximateTokens).toBeGreaterThan(0);
  });

  it('truncates oversized tool result content with an explicit marker', () => {
    const builder = new EventContextBuilder({
      systemPrompt: 'SYSTEM',
      toolResultMaxChars: 50,
    });
    const history = [
      event('turn.started', { goal: 'goal' }),
      event('model.tool_call', {
        call: { id: 'call-1', name: 'run_command', arguments: { command: 'pnpm test' } },
      }),
      event('tool.completed', {
        result: toolResult('completed', 'x'.repeat(500), 'call-1', 'run_command'),
        durationMs: 10,
      }),
    ];

    const projection = builder.build(history, largeBudget);
    const toolMessage = projection.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('truncated');
    expect(toolMessage?.content.length).toBeLessThan(500);
    expect(projection.truncations.length).toBe(1);
    expect(projection.truncations[0]?.originalSize).toBe(500);
  });

  it('preserves the goal and system prompt even under a tiny budget', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM CONSTRAINTS' });
    const tinyBudget: ContextBudget = { maxApproxTokens: 30, reservedOutputTokens: 4 };

    const projection = builder.build(simpleHistory(), tinyBudget);

    const roles = projection.messages.map((message) => message.role);
    expect(roles[0]).toBe('system');
    expect(projection.messages).toContainEqual({ role: 'user', content: 'Fix the failing tests' });
  });

  it('summarizes older steps instead of dropping them silently', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM' });
    const history: EchoEvent[] = [event('turn.started', { goal: 'goal' })];

    for (let step = 1; step <= 3; step += 1) {
      history.push(event('step.started', { step }));
      history.push(
        event('model.tool_call', {
          call: {
            id: `call-${step}`,
            name: 'read_file',
            arguments: { path: `src/file${step}.ts` },
          },
        }),
      );
      history.push(
        event('tool.completed', {
          result: toolResult('completed', `content ${step}`, `call-${step}`),
          durationMs: 2,
        }),
      );
      history.push(event('model.text_delta', { delta: `Step ${step} analysis text. ` }));
    }

    const smallBudget: ContextBudget = { maxApproxTokens: 80, reservedOutputTokens: 4 };
    const projection = builder.build(history, smallBudget);

    expect(projection.omittedEventCount).toBeGreaterThan(0);
    const summaryMessage = projection.messages.find(
      (message) => message.role === 'user' && message.content.includes('Step'),
    );
    expect(summaryMessage).toBeDefined();
    expect(summaryMessage?.content).toContain('read_file');
  });

  it('keeps the most recent step verbatim while summarizing older ones', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM' });
    const history: EchoEvent[] = [event('turn.started', { goal: 'goal' })];

    for (let step = 1; step <= 3; step += 1) {
      history.push(event('step.started', { step }));
      history.push(
        event('model.text_delta', {
          delta: `${'analysis '.repeat(60)}step ${step}`,
        }),
      );
      history.push(
        event('model.tool_call', {
          call: {
            id: `call-${step}`,
            name: 'read_file',
            arguments: { path: `src/file${step}.ts` },
          },
        }),
      );
      history.push(
        event('tool.completed', {
          result: toolResult('completed', `result for step ${step}`, `call-${step}`),
          durationMs: 2,
        }),
      );
    }

    const smallBudget: ContextBudget = { maxApproxTokens: 500, reservedOutputTokens: 4 };
    const projection = builder.build(history, smallBudget);

    const toolMessages = projection.messages.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    const lastTool = toolMessages[toolMessages.length - 1];
    expect(lastTool?.content).toContain('result for step 3');
  });

  it('pairs every assistant tool call with its tool result message', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM' });
    const projection = builder.build(simpleHistory(), largeBudget);

    const assistant = projection.messages.find(
      (message): message is Extract<ModelMessage, { role: 'assistant' }> =>
        message.role === 'assistant' && message.toolCalls !== undefined,
    );
    expect(assistant?.toolCalls).toHaveLength(1);

    const toolMessage = projection.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.toolCallId).toBe(assistant?.toolCalls?.[0]?.id);
  });

  it('renders tool failures and denials with their status', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM' });
    const history: EchoEvent[] = [
      event('turn.started', { goal: 'goal' }),
      event('model.tool_call', {
        call: { id: 'call-2', name: 'run_command', arguments: { command: 'bad' } },
      }),
      event('tool.failed', {
        result: toolResult('failed', 'boom', 'call-2', 'run_command'),
        durationMs: 5,
      }),
      event('model.tool_call', {
        call: { id: 'call-3', name: 'write_file', arguments: { path: 'x' } },
      }),
      event('tool.denied', {
        result: toolResult('denied', 'outside workspace', 'call-3', 'write_file'),
        hard: true,
      }),
    ];

    const projection = builder.build(history, largeBudget);
    const contents = projection.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.content);

    expect(contents.some((content) => content.startsWith('[failed]'))).toBe(true);
    expect(contents.some((content) => content.startsWith('[denied]'))).toBe(true);
  });

  it('omits orphaned or mismatched tool calls and results', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM' });
    const history: EchoEvent[] = [
      event('turn.started', { goal: 'goal' }),
      event('step.started', { step: 1 }),
      event('model.tool_call', {
        call: { id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } },
      }),
      event('tool.completed', {
        result: toolResult('completed', 'wrong result', 'call-other', 'read_file'),
        durationMs: 2,
      }),
      event('model.tool_call', {
        call: { id: 'call-2', name: 'write_file', arguments: { path: 'src/b.ts' } },
      }),
      event('tool.completed', {
        result: toolResult('completed', 'wrong tool', 'call-2', 'read_file'),
        durationMs: 2,
      }),
    ];

    const projection = builder.build(history, largeBudget);
    expect(projection.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(
      projection.messages.some(
        (message) => message.role === 'assistant' && message.toolCalls !== undefined,
      ),
    ).toBe(false);
  });

  it('produces a deterministic projection for identical inputs', () => {
    const builder = new EventContextBuilder({ systemPrompt: 'SYSTEM' });
    const history = simpleHistory();
    const first = builder.build(history, largeBudget);
    const second = builder.build(history, largeBudget);
    expect(first).toEqual(second);
  });

  it('projects a workspace summary message when provided', () => {
    const builder = new EventContextBuilder({
      systemPrompt: 'SYSTEM',
      workspaceSummary: 'Workspace: demo-repo; platform: windows',
    });
    const projection = builder.build(simpleHistory(), largeBudget);
    expect(projection.messages).toContainEqual({
      role: 'system',
      content: 'Workspace: demo-repo; platform: windows',
    });
  });
});
