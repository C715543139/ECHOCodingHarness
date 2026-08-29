import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EVENT_SCHEMA_VERSION, type EchoEvent } from '../../../src/contracts/index.js';
import {
  createProviderIdentity,
  JsonlSessionRepository,
  JsonlSessionStore,
} from '../../../src/session/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-session-repo-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('JsonlSessionRepository', () => {
  it('creates a version-2 session summary from input without a second file read', async () => {
    const workspace = await temporaryWorkspace();
    const provider = createProviderIdentity('https://provider.example/v1');
    const repository = new JsonlSessionRepository({
      workspaceRoot: workspace,
      now: () => '2026-08-29T00:00:00.000Z',
      idFactory: (kind) => `${kind}-fixed`,
    });

    const summary = await repository.create({
      workspaceRoot: workspace,
      provider,
      model: 'fake-model',
      safetyMode: 'balanced',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
    });

    expect(summary).toEqual({
      sessionId: 'session-fixed',
      updatedAt: '2026-08-29T00:00:00.000Z',
      turnCount: 0,
      eventSchemaVersion: 2,
      provider,
      model: 'fake-model',
      safetyMode: 'balanced',
    });
    const listed = await repository.list(workspace);
    expect(listed).toEqual([summary]);
    const view = await repository.getQueryView(summary.sessionId);
    expect(view.runtime.model.value).toBe('fake-model');
    expect(view.runtime.provider).toEqual(provider);
    expect(view.turns).toEqual([]);
  });

  it('fails closed on empty, incompatible, and Provider-mismatched sessions', async () => {
    const workspace = await temporaryWorkspace();
    const provider = createProviderIdentity('https://provider.example/v1');
    const other = createProviderIdentity('https://other.example/v1');
    const repository = new JsonlSessionRepository({ workspaceRoot: workspace });
    const store = new JsonlSessionStore({ workspaceRoot: workspace });

    await expect(
      repository.resume({
        workspaceRoot: workspace,
        sessionId: 'session-missing',
        provider,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_SESSION_NOT_FOUND' });

    await fs.mkdir(path.join(workspace, '.echo', 'sessions'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, '.echo', 'sessions', 'session-empty.jsonl'),
      '',
      'utf8',
    );
    await expect(
      repository.resume({
        workspaceRoot: workspace,
        sessionId: 'session-empty',
        provider,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_SESSION_NOT_FOUND' });

    const p0: EchoEvent = {
      id: 'event-1',
      sequence: 1,
      timestamp: '2026-08-29T00:00:00.000Z',
      sessionId: 'session-p0',
      type: 'session.started',
      payload: { workspace: '.', safetyMode: 'balanced' },
    };
    await store.append(p0);
    await expect(
      repository.resume({
        workspaceRoot: workspace,
        sessionId: 'session-p0',
        provider,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_SESSION_INCOMPATIBLE' });

    const created = await repository.create({
      workspaceRoot: workspace,
      provider,
      model: 'fake-model',
      safetyMode: 'safe',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
    });
    await expect(
      repository.resume({
        workspaceRoot: workspace,
        sessionId: created.sessionId,
        provider: other,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_PROVIDER_MISMATCH' });
  });

  it('compensates hung tools and turns on resume instead of treating them as success', async () => {
    const workspace = await temporaryWorkspace();
    const provider = createProviderIdentity('https://provider.example/v1');
    const repository = new JsonlSessionRepository({
      workspaceRoot: workspace,
      now: () => '2026-08-29T00:00:00.000Z',
    });
    const created = await repository.create({
      workspaceRoot: workspace,
      provider,
      model: 'fake-model',
      safetyMode: 'balanced',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
    });
    await repository.append({
      id: 'event-turn',
      sequence: 2,
      timestamp: '2026-08-29T00:00:00.000Z',
      sessionId: created.sessionId,
      turnId: 'turn-hung',
      type: 'turn.started',
      payload: { goal: 'unfinished' },
    });
    await repository.append({
      id: 'event-tool',
      sequence: 3,
      timestamp: '2026-08-29T00:00:00.000Z',
      sessionId: created.sessionId,
      turnId: 'turn-hung',
      stepId: 'step-1',
      type: 'tool.requested',
      payload: {
        call: { id: 'call-hung', name: 'inspect', arguments: {} },
        normalizedInput: {},
      },
    });

    const view = await repository.resume({
      workspaceRoot: workspace,
      sessionId: created.sessionId,
      provider,
    });
    expect(view.runtime.activeTurnId).toBeUndefined();
    expect(view.turns[0]?.status).toBe('failed');
    expect(view.events.some((event) => event.type === 'tool.failed')).toBe(true);
    expect(view.events.some((event) => event.type === 'turn.failed')).toBe(true);
    expect(
      view.events.filter((event) => event.type === 'tool.failed' || event.type === 'turn.failed'),
    ).toHaveLength(2);
  });
});
