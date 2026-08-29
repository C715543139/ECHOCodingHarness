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
      'model.text_delta',
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
});
