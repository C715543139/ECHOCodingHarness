import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ActiveTurnCoordinator, EchoApplicationService } from '../../../src/application/index.js';
import { EventContextBuilder } from '../../../src/context/index.js';
import type { EchoEvent, ModelProvider, SafetyPolicy } from '../../../src/contracts/index.js';
import { FakeProvider } from '../../../src/provider/index.js';
import { createProviderIdentity, JsonlSessionRepository } from '../../../src/session/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';
import { createSessionEventHub } from '../../../src/web/sse-hub.js';

import { GatedProvider } from '../../integration/web/session-api-harness.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-active-turn-'));
  temporaryDirectories.push(directory);
  return directory;
}

function allowPolicy(): SafetyPolicy {
  return {
    evaluate: async () => ({ action: 'allow', reason: 'allow', ruleId: 'policy.test.allow' }),
  };
}

function completedProvider(): FakeProvider {
  return new FakeProvider([
    {
      events: [
        { type: 'text_delta', delta: 'done' },
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
}

async function createService(
  workspace: string,
  provider: ModelProvider,
): Promise<{
  service: EchoApplicationService;
  coordinator: ActiveTurnCoordinator;
  identity: ReturnType<typeof createProviderIdentity>;
}> {
  const identity = createProviderIdentity('https://provider.example/v1');
  const hub = createSessionEventHub();
  const service = new EchoApplicationService({
    repository: new JsonlSessionRepository({ workspaceRoot: workspace }),
    provider,
    providerIdentity: identity,
    tools: new ToolRegistry([]),
    policy: allowPolicy(),
    contextBuilder: new EventContextBuilder({ systemPrompt: 'system constraints' }),
    workspaceRoot: workspace,
    maxSteps: 4,
    contextBudget: { maxApproxTokens: 4_000, reservedOutputTokens: 500 },
    toolLimits: { timeoutMs: 1_000, maxOutputChars: 4_000 },
    unattendedApproval: 'wait',
    onEvent: (event: EchoEvent) => {
      hub.publish(event);
    },
  });
  return {
    service,
    coordinator: new ActiveTurnCoordinator({ service, waiter: hub }),
    identity,
  };
}

describe('ActiveTurnCoordinator', () => {
  it('admits one process-wide turn and rejects a second session until the first settles', async () => {
    const workspace = await temporaryWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, coordinator, identity } = await createService(
      workspace,
      new GatedProvider(completedProvider(), gate),
    );
    const first = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'balanced', source: 'config' },
    });
    const second = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'balanced', source: 'config' },
    });

    const accepted = coordinator.submitTurn(first.sessionId, 'run first');
    const blocked = await coordinator.submitTurn(second.sessionId, 'run second');
    expect(blocked.kind).toBe('turn_active');
    if (blocked.kind === 'turn_active') {
      expect(blocked.activeSessionId).toBe(first.sessionId);
    }

    const running = await accepted;
    expect(running.kind).toBe('accepted');
    expect(coordinator.snapshot().sessionId).toBe(first.sessionId);

    release();
    if (running.kind === 'accepted') await running.promise;
    expect(coordinator.snapshot().sessionId).toBeUndefined();

    const after = await coordinator.submitTurn(second.sessionId, 'run second');
    expect(after.kind).toBe('accepted');
    if (after.kind === 'accepted') await after.promise;
  });

  it('cancels the active turn and reports not_active once it has settled', async () => {
    const workspace = await temporaryWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, coordinator, identity } = await createService(
      workspace,
      new GatedProvider(completedProvider(), gate),
    );
    const session = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'balanced', source: 'config' },
    });
    const accepted = await coordinator.submitTurn(session.sessionId, 'hold');
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('expected accepted turn');

    const cancelling = await coordinator.cancelTurn(session.sessionId, accepted.turnId);
    expect(cancelling).toEqual({
      kind: 'cancelling',
      sessionId: session.sessionId,
      turnId: accepted.turnId,
    });
    await accepted.promise.catch(() => undefined);
    const idle = await coordinator.cancelTurn(session.sessionId, accepted.turnId);
    expect(idle.kind).toBe('not_active');
    release();
  });
});
