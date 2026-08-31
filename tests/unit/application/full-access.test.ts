import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EchoApplicationService } from '../../../src/application/index.js';
import type {
  EchoEvent,
  FullAccessConfirmation,
  ModelProvider,
  SafetyPolicy,
} from '../../../src/contracts/index.js';
import { EventContextBuilder } from '../../../src/context/index.js';
import { FakeProvider } from '../../../src/provider/index.js';
import { createProviderIdentity, JsonlSessionRepository } from '../../../src/session/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';

const temporaryDirectories: string[] = [];
const identity = createProviderIdentity('https://provider.example/v1');
const CLI_CONFIRMATION: FullAccessConfirmation = {
  acceptedRisk: true,
  source: 'cli-interactive',
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-full-access-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createService(input: {
  readonly workspace: string;
  readonly provider?: ModelProvider;
  readonly policy?: SafetyPolicy;
  readonly onEvent?: (event: EchoEvent) => void;
}): EchoApplicationService {
  return new EchoApplicationService({
    repository: new JsonlSessionRepository({ workspaceRoot: input.workspace }),
    provider:
      input.provider ??
      new FakeProvider([
        {
          events: [
            { type: 'text_delta', delta: 'done' },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
      ]),
    providerIdentity: identity,
    tools: new ToolRegistry([]),
    policy:
      input.policy ??
      ({
        evaluate: vi.fn().mockResolvedValue({
          action: 'allow',
          reason: 'allowed',
          ruleId: 'policy.test.allow',
        }),
      } satisfies SafetyPolicy),
    contextBuilder: new EventContextBuilder({ systemPrompt: 'system constraints' }),
    workspaceRoot: input.workspace,
    maxSteps: 4,
    contextBudget: { maxApproxTokens: 4_000, reservedOutputTokens: 500 },
    toolLimits: { timeoutMs: 1_000, maxOutputChars: 4_000 },
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  });
}

describe('Full Access session authorization', () => {
  it('requires a valid human confirmation before persisting a new Full Access session', async () => {
    const workspace = await temporaryWorkspace();
    const service = createService({ workspace });
    const create = (confirmation?: FullAccessConfirmation) =>
      service.createSession({
        workspaceRoot: workspace,
        provider: identity,
        model: { value: 'fake-model', source: 'config' },
        safetyMode: { value: 'full-access', source: 'config' },
        ...(confirmation === undefined ? {} : { fullAccessConfirmation: confirmation }),
      });

    await expect(create()).rejects.toMatchObject({ code: 'FULL_ACCESS_CONFIRMATION_REQUIRED' });
    await expect(create({ acceptedRisk: true, source: 'model' } as never)).rejects.toMatchObject({
      code: 'FULL_ACCESS_CONFIRMATION_REQUIRED',
    });
    await expect(service.listSessions(workspace)).resolves.toEqual([]);

    const created = await create(CLI_CONFIRMATION);
    expect(created.safetyMode).toEqual({ value: 'full-access', source: 'config' });
    const events = await service.getSession(created.sessionId);
    expect(events.events[0]).toMatchObject({
      type: 'session.started',
      payload: { safetyMode: 'full-access' },
    });
  });

  it('inherits persisted authorization on resume but requires fresh confirmation after revocation', async () => {
    const workspace = await temporaryWorkspace();
    const first = createService({ workspace });
    const created = await first.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'full-access', source: 'cli' },
      fullAccessConfirmation: CLI_CONFIRMATION,
    });

    const restarted = createService({ workspace });
    const resumed = await restarted.resumeSession({
      workspaceRoot: workspace,
      sessionId: created.sessionId,
      provider: identity,
    });
    expect(resumed.safetyMode).toEqual({ value: 'full-access', source: 'session' });

    const revoked = await restarted.setSessionSafetyMode(created.sessionId, 'balanced');
    expect(revoked.safetyMode.value).toBe('balanced');
    await expect(
      restarted.setSessionSafetyMode(created.sessionId, 'full-access'),
    ).rejects.toMatchObject({ code: 'FULL_ACCESS_CONFIRMATION_REQUIRED' });

    const restored = await restarted.setSessionSafetyMode(
      created.sessionId,
      'full-access',
      CLI_CONFIRMATION,
    );
    expect(restored.safetyMode.value).toBe('full-access');
    const view = await restarted.getSession(created.sessionId);
    expect(
      view.events
        .filter((event) => event.type === 'safety.changed')
        .map((event) => event.payload.safetyMode),
    ).toEqual(['balanced', 'full-access']);
  });

  it('requires confirmation for a resume override that enters Full Access', async () => {
    const workspace = await temporaryWorkspace();
    const first = createService({ workspace });
    const created = await first.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'safe', source: 'config' },
    });
    const restarted = createService({ workspace });

    await expect(
      restarted.resumeSession({
        workspaceRoot: workspace,
        sessionId: created.sessionId,
        provider: identity,
        cliSafetyMode: 'full-access',
      }),
    ).rejects.toMatchObject({ code: 'FULL_ACCESS_CONFIRMATION_REQUIRED' });

    const resumed = await restarted.resumeSession({
      workspaceRoot: workspace,
      sessionId: created.sessionId,
      provider: identity,
      cliSafetyMode: 'full-access',
      fullAccessConfirmation: { acceptedRisk: true, source: 'cli-flag' },
    });
    expect(resumed.safetyMode).toEqual({ value: 'full-access', source: 'cli' });
  });

  it('does not enter or leave Full Access while a turn is active', async () => {
    const workspace = await temporaryWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: ModelProvider = {
      name: 'gated',
      stream: () =>
        (async function* stream() {
          started();
          await gate;
          yield { type: 'text_delta' as const, delta: 'done' };
          yield { type: 'completed' as const, finishReason: 'stop' as const };
        })(),
    };
    const service = createService({ workspace, provider });
    const created = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'full-access', source: 'cli' },
      fullAccessConfirmation: CLI_CONFIRMATION,
    });

    const turn = service.runTurn({ sessionId: created.sessionId, goal: 'wait' });
    await entered;
    await expect(service.setSessionSafetyMode(created.sessionId, 'balanced')).rejects.toMatchObject(
      { code: 'CONFIG_SESSION_INCOMPATIBLE' },
    );
    release();
    await expect(turn).resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects every safety-mode switch during a turn without changing other modes afterward', async () => {
    const workspace = await temporaryWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: ModelProvider = {
      name: 'gated',
      stream: () =>
        (async function* stream() {
          started();
          await gate;
          yield { type: 'text_delta' as const, delta: 'done' };
          yield { type: 'completed' as const, finishReason: 'stop' as const };
        })(),
    };
    const service = createService({ workspace, provider });
    const created = await service.createSession({
      workspaceRoot: workspace,
      provider: identity,
      model: { value: 'fake-model', source: 'config' },
      safetyMode: { value: 'safe', source: 'config' },
    });

    const turn = service.runTurn({ sessionId: created.sessionId, goal: 'wait' });
    await entered;
    await expect(service.setSessionSafetyMode(created.sessionId, 'balanced')).rejects.toMatchObject(
      { code: 'CONFIG_SESSION_INCOMPATIBLE' },
    );
    await expect(service.setSessionSafetyMode(created.sessionId, 'auto')).rejects.toMatchObject({
      code: 'CONFIG_SESSION_INCOMPATIBLE',
    });
    release();
    await expect(turn).resolves.toMatchObject({ status: 'completed' });
    await expect(
      service.setSessionSafetyMode(created.sessionId, 'balanced'),
    ).resolves.toMatchObject({ safetyMode: { value: 'balanced' } });
    await expect(service.setSessionSafetyMode(created.sessionId, 'auto')).resolves.toMatchObject({
      safetyMode: { value: 'auto' },
    });
  });
});
