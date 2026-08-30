import { describe, expect, it, vi } from 'vitest';

import type {
  EchoEvent,
  SafetyPolicy,
  SessionStore,
  ToolDefinition,
} from '../../../src/contracts/index.js';
import { EventContextBuilder } from '../../../src/context/index.js';
import { AgentLoop } from '../../../src/agent/index.js';
import { FakeProvider } from '../../../src/provider/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';

class MemoryStore implements SessionStore {
  readonly events: EchoEvent[] = [];
  async append(event: EchoEvent): Promise<void> {
    this.events.push(event);
  }
  async *read(sessionId: string): AsyncIterable<EchoEvent> {
    void sessionId;
    yield* this.events;
  }
}

class FailOnceStore implements SessionStore {
  readonly backing = new MemoryStore();
  private failed = false;

  constructor(private readonly eventType: EchoEvent['type']) {}

  async append(event: EchoEvent): Promise<void> {
    if (!this.failed && event.type === this.eventType) {
      this.failed = true;
      throw {
        category: 'storage',
        code: 'INJECTED_STORAGE_FAILURE',
        message: 'Injected one-shot storage failure.',
        retryable: true,
      };
    }
    await this.backing.append(event);
  }

  read(sessionId: string): AsyncIterable<EchoEvent> {
    return this.backing.read(sessionId);
  }
}

class PersistThenFailOnceStore implements SessionStore {
  readonly backing = new MemoryStore();
  private failed = false;

  constructor(private readonly eventType: EchoEvent['type']) {}

  async append(event: EchoEvent): Promise<void> {
    await this.backing.append(event);
    if (!this.failed && event.type === this.eventType) {
      this.failed = true;
      throw {
        category: 'storage',
        code: 'INJECTED_AMBIGUOUS_STORAGE_FAILURE',
        message: 'Injected storage failure after persistence.',
        retryable: true,
      };
    }
  }

  read(sessionId: string): AsyncIterable<EchoEvent> {
    return this.backing.read(sessionId);
  }
}

const allowPolicy: SafetyPolicy = {
  evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'test allow' }),
};

function tool(name = 'inspect'): ToolDefinition<unknown, { value: string }> {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object' },
    execute: vi.fn().mockResolvedValue({
      status: 'completed',
      summary: 'inspected',
      data: { value: 'observation' },
      truncated: false,
    }),
  };
}

function createLoop(options: {
  provider: FakeProvider;
  store: SessionStore;
  tools?: readonly ToolDefinition<unknown>[];
  policy?: SafetyPolicy;
  maxSteps?: number;
  repeatedToolCallLimit?: number;
}) {
  return new AgentLoop({
    provider: options.provider,
    model: 'fake-model',
    tools: new ToolRegistry(options.tools ?? []),
    policy: options.policy ?? allowPolicy,
    contextBuilder: new EventContextBuilder({ systemPrompt: 'system constraints' }),
    sessionStore: options.store,
    workspaceRoot: 'C:\\workspace',
    safetyMode: 'balanced',
    maxSteps: options.maxSteps ?? 4,
    repeatedToolCallLimit: options.repeatedToolCallLimit ?? 3,
    contextBudget: { maxApproxTokens: 4_000, reservedOutputTokens: 500 },
    toolLimits: { timeoutMs: 1_000, maxOutputChars: 4_000 },
    idFactory: (() => {
      let id = 0;
      return (kind: string) => `${kind}-${String(++id)}`;
    })(),
    now: () => '2026-08-28T00:00:00.000Z',
  });
}

describe('AgentLoop', () => {
  it('completes a text-only response and persists lifecycle events in sequence', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store }).run('finish the task');

    expect(result).toMatchObject({
      status: 'completed',
      stopReason: 'completed',
      finalText: 'done',
      steps: 1,
      toolCalls: 0,
    });
    expect(store.events.map((item) => item.type)).toEqual([
      'session.started',
      'turn.started',
      'step.started',
      'context.projected',
      'model.started',
      'model.text',
      'model.completed',
      'turn.completed',
    ]);
    expect(store.events.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('executes tool calls sequentially and feeds terminal results to the next model request', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: { path: 'a' } } },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'finished after inspection' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store, tools: [inspect] }).run('inspect');

    expect(result).toMatchObject({ status: 'completed', steps: 2, toolCalls: 1 });
    expect(inspect.execute).toHaveBeenCalledOnce();
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [expect.objectContaining({ id: 'call-1' })],
        }),
        expect.objectContaining({ role: 'tool', toolCallId: 'call-1' }),
      ]),
    );
    expect(store.events.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        'tool.requested',
        'tool.authorized',
        'tool.started',
        'tool.completed',
      ]),
    );
  });

  it('turns a policy denial into exactly one tool terminal and a failed result', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    const store = new MemoryStore();
    const policy: SafetyPolicy = {
      evaluate: vi.fn().mockResolvedValue({ action: 'deny', reason: 'forbidden', hard: true }),
    };

    const result = await createLoop({ provider, store, tools: [tool()], policy }).run('inspect');

    expect(result).toMatchObject({ status: 'failed', stopReason: 'policy_denied', toolCalls: 1 });
    expect(
      store.events.filter((item) => item.type.startsWith('tool.')).map((item) => item.type),
    ).toEqual(['tool.requested', 'tool.denied']);
  });

  it('limits repeated equivalent tool calls before executing the threshold call', async () => {
    const inspect = tool();
    const scripted = [1, 2].map((index) => ({
      events: [
        {
          type: 'tool_call' as const,
          call: { id: `call-${String(index)}`, name: 'inspect', arguments: { b: 2, a: 1 } },
        },
        { type: 'completed' as const, finishReason: 'tool_calls' as const },
      ],
    }));
    const provider = new FakeProvider(scripted);
    const store = new MemoryStore();

    const result = await createLoop({
      provider,
      store,
      tools: [inspect],
      repeatedToolCallLimit: 2,
    }).run('loop');

    expect(result).toMatchObject({ status: 'limited', stopReason: 'repeated_tool_call', steps: 2 });
    expect(inspect.execute).toHaveBeenCalledOnce();
    expect(store.events.some((item) => item.type === 'limit.reached')).toBe(true);
    expect(store.events.filter((item) => item.type === 'tool.denied')).toHaveLength(1);
  });

  it('returns provider_error and records the normalized provider failure', async () => {
    const provider = new FakeProvider([
      {
        events: [],
        error: {
          category: 'provider_network',
          code: 'OFFLINE',
          message: 'network unavailable',
          retryable: false,
        },
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store }).run('fail');

    expect(result).toMatchObject({ status: 'failed', stopReason: 'provider_error' });
    expect(store.events.map((item) => item.type).slice(-2)).toEqual([
      'model.failed',
      'turn.failed',
    ]);
  });

  it('feeds recoverable tool failures back to the model instead of claiming tool success', async () => {
    const failing: ToolDefinition<unknown> = {
      name: 'inspect',
      description: 'fails',
      inputSchema: { type: 'object' },
      execute: vi.fn().mockResolvedValue({
        status: 'failed',
        summary: 'bad input',
        error: {
          category: 'invalid_tool_input',
          code: 'BAD_INPUT',
          message: 'bad input',
          retryable: false,
        },
        truncated: false,
      }),
    };
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'recovered' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store, tools: [failing] }).run('recover');

    expect(result).toMatchObject({ status: 'completed', finalText: 'recovered' });
    expect(store.events.filter((item) => item.type === 'tool.failed')).toHaveLength(1);
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool', content: expect.stringContaining('[failed]') }),
      ]),
    );
  });

  it('records max_steps after completing all requested tools in the last allowed step', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store, tools: [inspect], maxSteps: 1 }).run(
      'limit',
    );

    expect(result).toMatchObject({ status: 'limited', stopReason: 'max_steps', steps: 1 });
    expect(inspect.execute).toHaveBeenCalledOnce();
    expect(store.events.map((item) => item.type).slice(-2)).toEqual([
      'limit.reached',
      'turn.failed',
    ]);
  });

  it('cancels before starting a model step when the signal is already aborted', async () => {
    const provider = new FakeProvider([]);
    const store = new MemoryStore();
    const controller = new AbortController();
    controller.abort();

    const result = await createLoop({ provider, store }).run('cancel', controller.signal);

    expect(result).toMatchObject({ status: 'cancelled', stopReason: 'cancelled', steps: 0 });
    expect(provider.requests).toHaveLength(0);
    expect(store.events.map((item) => item.type)).toEqual([
      'session.started',
      'turn.started',
      'turn.cancelled',
    ]);
  });

  it('reuses a session approval only for an equivalent normalized operation', async () => {
    const inspect = tool();
    const approvalHandler = {
      requestApproval: vi.fn().mockResolvedValue('session' as const),
    };
    const policy: SafetyPolicy = {
      evaluate: vi.fn().mockImplementation((request) =>
        Promise.resolve(
          request.sessionApprovals.has('approval-key')
            ? { action: 'allow', reason: 'session approval' }
            : {
                action: 'ask',
                reason: 'confirm',
                approvalKey: 'approval-key',
              },
        ),
      ),
    };
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: { a: 1 } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'tool_call', call: { id: 'call-2', name: 'inspect', arguments: { a: 1 } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: new ToolRegistry([inspect]),
      policy,
      contextBuilder: new EventContextBuilder({ systemPrompt: 'system constraints' }),
      sessionStore: store,
      workspaceRoot: 'C:\\workspace',
      safetyMode: 'balanced',
      maxSteps: 4,
      repeatedToolCallLimit: 3,
      contextBudget: { maxApproxTokens: 4_000, reservedOutputTokens: 500 },
      toolLimits: { timeoutMs: 1_000, maxOutputChars: 4_000 },
      approvalHandler,
    });

    const result = await loop.run('approve');

    expect(result.status).toBe('completed');
    expect(approvalHandler.requestApproval).toHaveBeenCalledOnce();
    expect(store.events.filter((item) => item.type === 'approval.granted')).toHaveLength(1);
    expect(inspect.execute).toHaveBeenCalledTimes(2);
  });

  it('continues a persisted session without emitting a second session.started event', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'first' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'second' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();
    const loop = createLoop({ provider, store });

    const first = await loop.run('first turn');
    const second = await loop.continueSession(first.sessionId, 'second turn');

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.finalText).toBe('second');
    expect(store.events.filter((item) => item.type === 'session.started')).toHaveLength(1);
    expect(store.events.filter((item) => item.type === 'turn.started')).toHaveLength(2);
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'first turn' }),
        expect.objectContaining({ role: 'user', content: 'second turn' }),
        expect.objectContaining({ role: 'assistant', content: 'first' }),
      ]),
    );
  });

  it('keeps consecutive identical goals in the continued-turn projection', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'first' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'again' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();
    const loop = createLoop({ provider, store });

    const first = await loop.run('retry');
    await loop.continueSession(first.sessionId, 'retry');

    expect(provider.requests[1]?.messages).toEqual([
      { role: 'system', content: 'system constraints' },
      { role: 'user', content: 'retry' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'retry' },
    ]);
  });

  it('does not let a failing event observer change orchestration state', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: new ToolRegistry([]),
      policy: allowPolicy,
      contextBuilder: new EventContextBuilder({ systemPrompt: 'system constraints' }),
      sessionStore: store,
      workspaceRoot: 'C:\\workspace',
      safetyMode: 'balanced',
      maxSteps: 2,
      contextBudget: { maxApproxTokens: 4_000, reservedOutputTokens: 500 },
      toolLimits: { timeoutMs: 1_000, maxOutputChars: 4_000 },
      onEvent: () => {
        throw new Error('renderer unavailable');
      },
    });

    await expect(loop.run('finish')).resolves.toMatchObject({ status: 'completed' });
    expect(store.events.at(-1)?.type).toBe('turn.completed');
  });

  it('repairs one tool terminal and turn.failed after a transient storage failure', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    const store = new FailOnceStore('tool.authorized');

    const result = await createLoop({ provider, store, tools: [inspect] }).run('repair storage');

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'tool_error',
      error: { category: 'storage', code: 'INJECTED_STORAGE_FAILURE' },
    });
    expect(inspect.execute).not.toHaveBeenCalled();
    const events = store.backing.events;
    expect(events.filter((event) => event.type === 'tool.requested')).toHaveLength(1);
    expect(
      events.filter((event) =>
        ['tool.completed', 'tool.failed', 'tool.denied', 'tool.cancelled'].includes(event.type),
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.failed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1);
  });

  it('does not duplicate a tool terminal when a failing append actually persisted it', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    const store = new PersistThenFailOnceStore('tool.completed');

    const result = await createLoop({ provider, store, tools: [inspect] }).run(
      'preserve terminal uniqueness',
    );

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'tool_error',
      error: { category: 'storage', code: 'INJECTED_AMBIGUOUS_STORAGE_FAILURE' },
    });
    expect(inspect.execute).toHaveBeenCalledOnce();
    const events = store.backing.events;
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.failed')).toHaveLength(0);
    expect(
      events.filter((event) =>
        ['tool.completed', 'tool.failed', 'tool.denied', 'tool.cancelled'].includes(event.type),
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1);
  });

  it('rejects duplicate tool-call IDs in one response before requesting or executing tools', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'duplicate', name: 'inspect', arguments: { a: 1 } } },
          { type: 'tool_call', call: { id: 'duplicate', name: 'inspect', arguments: { a: 2 } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store, tools: [inspect] }).run('reject duplicate');

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'provider_error',
      error: { category: 'provider_protocol', code: 'PROVIDER_DUPLICATE_TOOL_CALL_ID' },
      toolCalls: 0,
    });
    expect(inspect.execute).not.toHaveBeenCalled();
    expect(store.events.filter((event) => event.type === 'tool.requested')).toHaveLength(0);
  });

  it('rejects a tool-call ID reused across steps without executing it again', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'reused', name: 'inspect', arguments: { a: 1 } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'tool_call', call: { id: 'reused', name: 'inspect', arguments: { a: 2 } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store, tools: [inspect] }).run('reject reuse');

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'provider_error',
      error: { category: 'provider_protocol', code: 'PROVIDER_DUPLICATE_TOOL_CALL_ID' },
      steps: 2,
      toolCalls: 1,
    });
    expect(inspect.execute).toHaveBeenCalledOnce();
    expect(store.events.filter((event) => event.type === 'tool.requested')).toHaveLength(1);
    expect(store.events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
  });

  it('rejects an empty tool-call ID as a provider protocol failure', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: '   ', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store, tools: [inspect] }).run('reject empty');

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'provider_error',
      error: { category: 'provider_protocol', code: 'PROVIDER_INVALID_TOOL_CALL_ID' },
      toolCalls: 0,
    });
    expect(inspect.execute).not.toHaveBeenCalled();
    expect(store.events.filter((event) => event.type === 'tool.requested')).toHaveLength(0);
  });

  it('aggregates reasoning into one session event and replays it with the next tool step', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'reasoning_delta', delta: { reasoning: 'think-' } },
          { type: 'reasoning_delta', delta: { reasoning: 'twice' } },
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: { path: 'a' } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store, tools: [inspect] }).run('inspect');

    expect(result.status).toBe('completed');
    expect(store.events.filter((event) => event.type === 'model.reasoning')).toHaveLength(1);
    expect(store.events.find((event) => event.type === 'model.reasoning')?.payload).toEqual({
      reasoning: 'think-twice',
    });
    const types = store.events.map((event) => event.type);
    expect(types.indexOf('model.reasoning')).toBeLessThan(types.indexOf('model.tool_call'));
    expect(types.indexOf('model.tool_call')).toBeLessThan(types.indexOf('model.completed'));
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning: 'think-twice',
          toolCalls: [expect.objectContaining({ id: 'call-1' })],
        }),
        expect.objectContaining({ role: 'tool', toolCallId: 'call-1' }),
      ]),
    );
  });

  it('normalizes many equivalent reasoning text fragments before session replay', async () => {
    const inspect = tool();
    const reasoning = 'plan carefully '.repeat(40);
    const fragments = [...reasoning].map((text) => ({
      type: 'reasoning_delta' as const,
      delta: {
        reasoning: text,
        reasoningDetails: [{ type: 'reasoning.text', text, format: 'x', index: 0 }],
      },
    }));
    const provider = new FakeProvider([
      {
        events: [
          ...fragments,
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: { path: 'a' } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();

    await createLoop({ provider, store, tools: [inspect] }).run('inspect');

    expect(store.events.filter((event) => event.type === 'model.reasoning')).toHaveLength(1);
    expect(store.events.find((event) => event.type === 'model.reasoning')?.payload).toEqual({
      reasoning,
    });
    const replayedAssistant = provider.requests[1]?.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(replayedAssistant).toEqual(expect.objectContaining({ role: 'assistant', reasoning }));
    expect(replayedAssistant).not.toHaveProperty('reasoningDetails');
  });

  it('persists the entire reasoning_details array when any non-text item is present', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'reasoning_delta', delta: { reasoning: 'think' } },
          {
            type: 'reasoning_delta',
            delta: {
              reasoningDetails: [
                { type: 'reasoning.text', text: 'think' },
                { type: 'reasoning.encrypted', data: 'blob', id: 'enc_1' },
                { type: 'reasoning.summary', summary: 'short' },
              ],
            },
          },
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: { path: 'a' } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();

    await createLoop({ provider, store, tools: [inspect] }).run('inspect');

    expect(store.events.find((event) => event.type === 'model.reasoning')?.payload).toEqual({
      reasoning: 'think',
      reasoningDetails: [
        { type: 'reasoning.text', text: 'think' },
        { type: 'reasoning.encrypted', data: 'blob', id: 'enc_1' },
        { type: 'reasoning.summary', summary: 'short' },
      ],
    });
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning: 'think',
          reasoningDetails: [
            { type: 'reasoning.text', text: 'think' },
            { type: 'reasoning.encrypted', data: 'blob', id: 'enc_1' },
            { type: 'reasoning.summary', summary: 'short' },
          ],
        }),
      ]),
    );
  });

  it('fails reasoning-only length responses instead of completing them', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'reasoning_delta', delta: { reasoningContent: 'hidden' } },
          { type: 'completed', finishReason: 'length' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store }).run('analyze');

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'provider_error',
      error: { code: 'PROVIDER_REASONING_BUDGET_EXHAUSTED' },
    });
    expect(store.events.some((event) => event.type === 'turn.completed')).toBe(false);
    expect(store.events.some((event) => event.type === 'model.reasoning')).toBe(true);
  });

  it('keeps partial text when length arrives without a tool call', async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'partial answer' },
          { type: 'completed', finishReason: 'length' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store }).run('write');

    expect(result).toMatchObject({
      status: 'limited',
      stopReason: 'output_limit',
      finalText: 'partial answer',
    });
    const textEvent = store.events.find((event) => event.type === 'model.text');
    expect(textEvent?.payload).toEqual({ text: 'partial answer' });
    expect(store.events.some((event) => event.type === 'model.text_delta')).toBe(false);
  });

  it('does not execute a tool call that finished with length', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'length' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store, tools: [inspect] }).run('inspect');

    expect(result).toMatchObject({ status: 'limited', stopReason: 'output_limit' });
    expect(inspect.execute).not.toHaveBeenCalled();
  });

  it('fails empty stop responses and content-filtered streams', async () => {
    const empty = await createLoop({
      provider: new FakeProvider([{ events: [{ type: 'completed', finishReason: 'stop' }] }]),
      store: new MemoryStore(),
    }).run('empty');
    expect(empty).toMatchObject({
      status: 'failed',
      error: { code: 'PROVIDER_EMPTY_RESPONSE' },
    });

    const filtered = await createLoop({
      provider: new FakeProvider([
        { events: [{ type: 'completed', finishReason: 'content_filter' }] },
      ]),
      store: new MemoryStore(),
    }).run('filter');
    expect(filtered).toMatchObject({
      status: 'failed',
      error: { code: 'PROVIDER_CONTENT_FILTERED' },
    });
  });

  it('persists already received reasoning before a stream failure', async () => {
    const provider = new FakeProvider([
      {
        events: [{ type: 'reasoning_delta', delta: { reasoning: 'partial-thought' } }],
        error: {
          category: 'provider_network',
          code: 'PROVIDER_STREAM_FAILED',
          message: 'stream dropped',
          retryable: false,
        },
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store }).run('continue');

    expect(result.status).toBe('failed');
    const types = store.events.map((event) => event.type);
    expect(types).toContain('model.reasoning');
    expect(types.indexOf('model.reasoning')).toBeLessThan(types.indexOf('model.failed'));
  });

  it('aggregates many single-character deltas into one model.text and never writes text_delta', async () => {
    const body = 'Hello, world! This is a long streamed reply.';
    const provider = new FakeProvider([
      {
        events: [
          ...[...body].map((character) => ({ type: 'text_delta' as const, delta: character })),
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();

    const result = await createLoop({ provider, store }).run('stream');

    expect(result).toMatchObject({ status: 'completed', finalText: body });
    const textEvents = store.events.filter((event) => event.type === 'model.text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.payload).toEqual({ text: body });
    expect(store.events.filter((event) => event.type === 'model.text_delta')).toHaveLength(0);
    const types = store.events.map((event) => event.type);
    expect(types.indexOf('model.text')).toBeLessThan(types.indexOf('model.completed'));
  });

  it('persists partial aggregated text before model.failed and turn.cancelled', async () => {
    const failStore = new MemoryStore();
    const failResult = await createLoop({
      provider: new FakeProvider([
        {
          events: [
            { type: 'text_delta', delta: 'hel' },
            { type: 'text_delta', delta: 'lo' },
          ],
          error: {
            category: 'provider_network',
            code: 'PROVIDER_STREAM_FAILED',
            message: 'stream dropped',
            retryable: false,
          },
        },
      ]),
      store: failStore,
    }).run('fail mid-stream');
    expect(failResult.status).toBe('failed');
    const failTypes = failStore.events.map((event) => event.type);
    expect(failStore.events.find((event) => event.type === 'model.text')?.payload).toEqual({
      text: 'hello',
      partial: true,
    });
    expect(failTypes.indexOf('model.text')).toBeLessThan(failTypes.indexOf('model.failed'));
    expect(failStore.events.some((event) => event.type === 'model.text_delta')).toBe(false);

    const cancelStore = new MemoryStore();
    const cancelResult = await createLoop({
      provider: new FakeProvider([
        {
          events: [
            { type: 'text_delta', delta: 'ab' },
            { type: 'text_delta', delta: 'orted' },
          ],
          error: {
            category: 'cancelled',
            code: 'TURN_CANCELLED',
            message: 'The agent turn was cancelled.',
            retryable: false,
          },
        },
      ]),
      store: cancelStore,
    }).run('cancel mid-stream');
    expect(cancelResult.status).toBe('cancelled');
    const cancelTypes = cancelStore.events.map((event) => event.type);
    expect(cancelStore.events.find((event) => event.type === 'model.text')?.payload).toEqual({
      text: 'aborted',
      partial: true,
    });
    expect(cancelTypes.indexOf('model.text')).toBeLessThan(cancelTypes.indexOf('model.failed'));
    expect(cancelTypes.indexOf('model.failed')).toBeLessThan(cancelTypes.indexOf('turn.cancelled'));
  });

  it('does not persist an empty model.text when no visible body arrived', async () => {
    const store = new MemoryStore();
    await createLoop({
      provider: new FakeProvider([
        {
          events: [],
          error: {
            category: 'provider_network',
            code: 'OFFLINE',
            message: 'network unavailable',
            retryable: false,
          },
        },
      ]),
      store,
    }).run('empty fail');
    expect(store.events.some((event) => event.type === 'model.text')).toBe(false);
    expect(store.events.some((event) => event.type === 'model.text_delta')).toBe(false);
  });

  it('keeps reasoning-before-text-before-completed order on a mixed response', async () => {
    const inspect = tool();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'reasoning_delta', delta: { reasoning: 'plan' } },
          { type: 'text_delta', delta: 'calling ' },
          { type: 'text_delta', delta: 'inspect' },
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const store = new MemoryStore();

    await createLoop({ provider, store, tools: [inspect] }).run('inspect');

    const firstText = store.events.find((event) => event.type === 'model.text');
    const firstReasoning = store.events.find((event) => event.type === 'model.reasoning');
    const firstTool = store.events.find((event) => event.type === 'model.tool_call');
    const firstCompleted = store.events.find((event) => event.type === 'model.completed');
    expect(firstText?.payload).toEqual({ text: 'calling inspect' });
    expect(firstReasoning?.sequence).toBeLessThan(firstText?.sequence ?? 0);
    expect(firstText?.sequence).toBeLessThan(firstTool?.sequence ?? 0);
    expect(firstTool?.sequence).toBeLessThan(firstCompleted?.sequence ?? 0);
    expect(store.events.filter((event) => event.type === 'model.text')).toHaveLength(2);
    expect(store.events.some((event) => event.type === 'model.text_delta')).toBe(false);
  });
});
