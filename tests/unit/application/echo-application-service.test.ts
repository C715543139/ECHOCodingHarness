import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EchoApplicationService } from '../../../src/application/index.js';
import { EventContextBuilder } from '../../../src/context/index.js';
import type { EchoEvent, SafetyPolicy, ToolDefinition } from '../../../src/contracts/index.js';
import { EVENT_SCHEMA_VERSION } from '../../../src/contracts/index.js';
import { FakeProvider } from '../../../src/provider/index.js';
import { createProviderIdentity, JsonlSessionRepository } from '../../../src/session/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-app-service-'));
  temporaryDirectories.push(directory);
  return directory;
}

const askPolicy: SafetyPolicy = {
  evaluate: vi.fn().mockResolvedValue({
    action: 'ask',
    reason: 'confirm test operation',
    approvalKey: 'approval-key',
    ruleId: 'policy.test.ask',
  }),
};

function inspectTool(): ToolDefinition<unknown, { value: string }> {
  return {
    name: 'inspect',
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

async function createService(options: {
  workspace: string;
  provider: FakeProvider;
  policy?: SafetyPolicy;
  tools?: readonly ToolDefinition<unknown>[];
  onEvent?: (event: EchoEvent) => void;
  unattendedApproval?: 'deny' | 'wait';
}): Promise<EchoApplicationService> {
  const identity = createProviderIdentity('https://provider.example/v1');
  return new EchoApplicationService({
    repository: new JsonlSessionRepository({ workspaceRoot: options.workspace }),
    provider: options.provider,
    providerIdentity: identity,
    tools: new ToolRegistry(options.tools ?? []),
    policy: options.policy ?? {
      evaluate: vi.fn().mockResolvedValue({
        action: 'allow',
        reason: 'allow',
        ruleId: 'policy.test.allow',
      }),
    },
    contextBuilder: new EventContextBuilder({ systemPrompt: 'system constraints' }),
    workspaceRoot: options.workspace,
    maxSteps: 4,
    contextBudget: { maxApproxTokens: 4_000, reservedOutputTokens: 500 },
    toolLimits: { timeoutMs: 1_000, maxOutputChars: 4_000 },
    unattendedApproval: options.unattendedApproval ?? 'wait',
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
}

describe('EchoApplicationService', () => {
  it('runs a Fake Provider turn through the application service and records version-2 events', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const events: EchoEvent[] = [];
    const service = await createService({
      workspace,
      provider,
      onEvent: (event) => {
        events.push(event);
      },
    });
    const identity = createProviderIdentity('https://provider.example/v1');

    const session = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'balanced', source: 'config' },
    });
    const result = await service.runTurn({ sessionId: session.sessionId, goal: 'finish the task' });
    const view = await service.getSession(session.sessionId);

    expect(result).toMatchObject({
      status: 'completed',
      finalText: 'done',
      sessionId: session.sessionId,
    });
    expect(session.model).toEqual({ value: 'fake-model', source: 'config' });
    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'turn.started',
      'step.started',
      'context.projected',
      'model.started',
      'model.text',
      'model.completed',
      'turn.completed',
    ]);
    expect(view.eventSchemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(view.runtime.provider.endpointFingerprint).not.toContain('https://');
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.steps).toHaveLength(1);
  });

  it('accepts an approval bound to turn, tool call, and key, then rejects duplicate, expired, and unknown responses', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: { path: 'a' } } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'finished' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    let requested: Extract<EchoEvent, { type: 'approval.requested' }> | undefined;
    let notifyRequested!: () => void;
    const ready = new Promise<void>((resolve) => {
      notifyRequested = resolve;
    });
    const service = await createService({
      workspace,
      provider,
      policy: askPolicy,
      tools: [inspectTool()],
      onEvent: (event) => {
        if (event.type === 'approval.requested') {
          requested = event;
          notifyRequested();
        }
      },
    });
    const identity = createProviderIdentity('https://provider.example/v1');
    const session = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'cli' },
      safetyMode: { value: 'balanced', source: 'cli' },
    });

    const turn = service.runTurn({ sessionId: session.sessionId, goal: 'inspect' });
    await ready;
    expect(requested).toBeDefined();
    const accepted = await service.respondToApproval({
      sessionId: session.sessionId,
      turnId: requested?.turnId ?? '',
      toolCallId: 'call-1',
      approvalKey: 'approval-key',
      choice: 'once',
    });
    expect(accepted).toEqual({ outcome: 'accepted', choice: 'once' });
    const duplicate = await service.respondToApproval({
      sessionId: session.sessionId,
      turnId: requested?.turnId ?? '',
      toolCallId: 'call-1',
      approvalKey: 'approval-key',
      choice: 'session',
    });
    expect(duplicate).toEqual({ outcome: 'rejected', reason: 'duplicate' });
    const unknown = await service.respondToApproval({
      sessionId: session.sessionId,
      turnId: requested?.turnId ?? '',
      toolCallId: 'call-missing',
      approvalKey: 'approval-key',
      choice: 'once',
    });
    expect(unknown).toEqual({ outcome: 'rejected', reason: 'not_pending' });
    await expect(turn).resolves.toMatchObject({ status: 'completed', finalText: 'finished' });

    const expired = await service.respondToApproval({
      sessionId: session.sessionId,
      turnId: 'turn-other',
      toolCallId: 'call-2',
      approvalKey: 'approval-key',
      choice: 'once',
    });
    expect(expired).toEqual({ outcome: 'rejected', reason: 'not_pending' });
  });

  it('cancels an in-flight turn and marks a waiting approval as expired', async () => {
    const workspace = await temporaryWorkspace();
    const provider = new FakeProvider([
      {
        events: [
          { type: 'tool_call', call: { id: 'call-1', name: 'inspect', arguments: {} } },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
    ]);
    let requested: EchoEvent | undefined;
    let notify!: () => void;
    const seen = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const service = await createService({
      workspace,
      provider,
      policy: askPolicy,
      tools: [inspectTool()],
      onEvent: (event) => {
        if (event.type === 'approval.requested') {
          requested = event;
          notify();
        }
      },
    });
    const identity = createProviderIdentity('https://provider.example/v1');
    const session = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'auto', source: 'config' },
    });
    const turn = service.runTurn({ sessionId: session.sessionId, goal: 'inspect' });
    await seen;
    await service.cancelTurn(session.sessionId, requested?.turnId);
    await expect(turn).resolves.toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    const expired = await service.respondToApproval({
      sessionId: session.sessionId,
      turnId: requested?.turnId ?? '',
      toolCallId: 'call-1',
      approvalKey: 'approval-key',
      choice: 'once',
    });
    expect(expired).toEqual({ outcome: 'rejected', reason: 'expired' });
  });

  it('resumes from events, applies CLI model override, and rejects a mismatched Provider', async () => {
    const workspace = await temporaryWorkspace();
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
    const identity = createProviderIdentity('https://provider.example/v1');
    const service = await createService({ workspace, provider });
    const session = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'balanced', source: 'config' },
    });
    await service.runTurn({ sessionId: session.sessionId, goal: 'first turn' });
    await service.setSessionSafetyMode(session.sessionId, 'safe');

    const resumed = await service.resumeSession({
      workspaceRoot: workspace,
      sessionId: session.sessionId,
      provider: identity,
      cliModel: 'other-model',
    });
    expect(resumed.model).toEqual({ value: 'other-model', source: 'cli' });
    expect(resumed.safetyMode).toEqual({ value: 'safe', source: 'session' });
    const second = await service.runTurn({ sessionId: session.sessionId, goal: 'second turn' });
    expect(second).toMatchObject({
      status: 'completed',
      finalText: 'second',
      sessionId: session.sessionId,
    });
    expect(provider.requests[1]?.model).toBe('other-model');

    const view = await service.getSession(session.sessionId);
    expect(view.events.some((event) => event.type === 'session.resumed')).toBe(true);
    expect(view.events.some((event) => event.type === 'model.changed')).toBe(true);
    expect(view.events.some((event) => event.type === 'safety.changed')).toBe(true);
    expect(view.turns).toHaveLength(2);

    await expect(
      service.resumeSession({
        workspaceRoot: workspace,
        sessionId: session.sessionId,
        provider: createProviderIdentity('https://other.example/v1'),
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_PROVIDER_MISMATCH' });
  });
});
