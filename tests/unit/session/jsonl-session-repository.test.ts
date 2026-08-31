import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EVENT_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION_P0,
  EVENT_SCHEMA_VERSION_P1,
  type EchoEvent,
} from '../../../src/contracts/index.js';
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
  it('deletes only the requested regular session log and reports a missing session', async () => {
    const workspace = await temporaryWorkspace();
    const provider = createProviderIdentity('https://provider.example/v1');
    let nextId = 0;
    const repository = new JsonlSessionRepository({
      workspaceRoot: workspace,
      idFactory: (kind) => `${kind}-${String((nextId += 1))}`,
    });
    const first = await repository.create({
      workspaceRoot: workspace,
      provider,
      model: 'fake-model',
      safetyMode: 'balanced',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
    });
    const second = await repository.create({
      workspaceRoot: workspace,
      provider,
      model: 'fake-model',
      safetyMode: 'balanced',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
    });

    await repository.delete(first.sessionId);

    await expect(repository.getQueryView(first.sessionId)).rejects.toMatchObject({
      code: 'CONFIG_SESSION_NOT_FOUND',
    });
    await expect(repository.getQueryView(second.sessionId)).resolves.toMatchObject({
      sessionId: second.sessionId,
    });
    await expect(repository.delete(first.sessionId)).rejects.toMatchObject({
      code: 'CONFIG_SESSION_NOT_FOUND',
    });
    await expect(
      repository.append({
        id: 'event-after-delete',
        sequence: 2,
        timestamp: '2026-08-29T00:00:01.000Z',
        sessionId: first.sessionId,
        type: 'session.resumed',
        payload: {
          eventSchemaVersion: EVENT_SCHEMA_VERSION,
          provider,
          model: 'fake-model',
          safetyMode: 'balanced',
          turnCount: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'SESSION_DELETED' });
  });

  it('refuses to delete a non-regular session path', async () => {
    const workspace = await temporaryWorkspace();
    const repository = new JsonlSessionRepository({ workspaceRoot: workspace });
    const sessionPath = path.join(workspace, '.echo', 'sessions', 'session-directory.jsonl');
    await fs.mkdir(sessionPath, { recursive: true });

    await expect(repository.delete('session-directory')).rejects.toMatchObject({
      code: 'SESSION_PATH_UNSAFE',
    });
    expect((await fs.lstat(sessionPath)).isDirectory()).toBe(true);
  });

  it('creates a version-3 session summary from input without a second file read', async () => {
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
      eventSchemaVersion: 3,
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

  it('round-trips a version-3 reasoning event and still resumes a version-2 session', async () => {
    const workspace = await temporaryWorkspace();
    const provider = createProviderIdentity('https://provider.example/v1');
    const repository = new JsonlSessionRepository({ workspaceRoot: workspace });
    const created = await repository.create({
      workspaceRoot: workspace,
      provider,
      model: 'fake-model',
      safetyMode: 'balanced',
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
    });
    await repository.append({
      id: 'event-reason',
      sequence: 2,
      timestamp: '2026-08-29T00:00:00.000Z',
      sessionId: created.sessionId,
      turnId: 'turn-1',
      stepId: 'step-1',
      type: 'model.reasoning',
      payload: { reasoning: 'kept', reasoningDetails: [{ id: 1 }] },
    });
    const view = await repository.getQueryView(created.sessionId);
    expect(view.eventSchemaVersion).toBe(3);
    expect(view.events.some((event) => event.type === 'model.reasoning')).toBe(true);

    const store = new JsonlSessionStore({ workspaceRoot: workspace });
    const v2: EchoEvent = {
      id: 'event-1',
      sequence: 1,
      timestamp: '2026-08-29T00:00:00.000Z',
      sessionId: 'session-v2',
      type: 'session.started',
      payload: {
        workspace: '.',
        safetyMode: 'balanced',
        eventSchemaVersion: EVENT_SCHEMA_VERSION_P1,
        provider,
        model: 'old-model',
      },
    };
    await store.append(v2);
    const resumed = await repository.resume({
      workspaceRoot: workspace,
      sessionId: 'session-v2',
      provider,
    });
    expect(resumed.eventSchemaVersion).toBe(2);
    expect(resumed.events.some((event) => event.type === 'model.reasoning')).toBe(false);
  });

  it('reads pre-revision text_delta logs and rejects mixed text representations', async () => {
    const workspace = await temporaryWorkspace();
    const provider = createProviderIdentity('https://provider.example/v1');
    const repository = new JsonlSessionRepository({ workspaceRoot: workspace });
    const store = new JsonlSessionStore({ workspaceRoot: workspace });

    const v2Delta: EchoEvent[] = [
      {
        id: 'event-1',
        sequence: 1,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-v2-delta',
        type: 'session.started',
        payload: {
          workspace: '.',
          safetyMode: 'balanced',
          eventSchemaVersion: EVENT_SCHEMA_VERSION_P1,
          provider,
          model: 'old-model',
        },
      },
      {
        id: 'event-2',
        sequence: 2,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-v2-delta',
        turnId: 'turn-1',
        stepId: 'step-1',
        type: 'turn.started',
        payload: { goal: 'old goal' },
      },
      {
        id: 'event-3',
        sequence: 3,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-v2-delta',
        turnId: 'turn-1',
        stepId: 'step-1',
        type: 'model.text_delta',
        payload: { delta: 'Hel' },
      },
      {
        id: 'event-4',
        sequence: 4,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-v2-delta',
        turnId: 'turn-1',
        stepId: 'step-1',
        type: 'model.text_delta',
        payload: { delta: 'lo' },
      },
    ];
    for (const item of v2Delta) await store.append(item);
    const resumedV2 = await repository.resume({
      workspaceRoot: workspace,
      sessionId: 'session-v2-delta',
      provider,
    });
    expect(resumedV2.eventSchemaVersion).toBe(2);
    expect(resumedV2.events.filter((event) => event.type === 'model.text_delta')).toHaveLength(2);
    expect(resumedV2.events.some((event) => event.type === 'model.text')).toBe(false);

    const v3Delta: EchoEvent[] = [
      {
        id: 'event-1',
        sequence: 1,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-v3-delta',
        type: 'session.started',
        payload: {
          workspace: '.',
          safetyMode: 'balanced',
          eventSchemaVersion: EVENT_SCHEMA_VERSION,
          provider,
          model: 'local-v3',
        },
      },
      {
        id: 'event-2',
        sequence: 2,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-v3-delta',
        turnId: 'turn-1',
        stepId: 'step-1',
        type: 'model.text_delta',
        payload: { delta: 'legacy v3 body' },
      },
    ];
    for (const item of v3Delta) await store.append(item);
    const queried = await repository.getQueryView('session-v3-delta');
    expect(queried.eventSchemaVersion).toBe(3);
    expect(queried.events.some((event) => event.type === 'model.text_delta')).toBe(true);

    const mixed: EchoEvent[] = [
      {
        id: 'event-1',
        sequence: 1,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-mixed',
        type: 'session.started',
        payload: {
          workspace: '.',
          safetyMode: 'balanced',
          eventSchemaVersion: EVENT_SCHEMA_VERSION,
          provider,
          model: 'fake-model',
        },
      },
      {
        id: 'event-2',
        sequence: 2,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-mixed',
        turnId: 'turn-1',
        stepId: 'step-1',
        type: 'model.text',
        payload: { text: 'aggregated' },
      },
      {
        id: 'event-3',
        sequence: 3,
        timestamp: '2026-08-29T00:00:00.000Z',
        sessionId: 'session-mixed',
        turnId: 'turn-1',
        stepId: 'step-1',
        type: 'model.text_delta',
        payload: { delta: 'delta' },
      },
    ];
    for (const item of mixed) await store.append(item);
    await expect(repository.getQueryView('session-mixed')).rejects.toMatchObject({
      code: 'SESSION_LOG_INVALID',
    });
    await expect(
      repository.resume({
        workspaceRoot: workspace,
        sessionId: 'session-mixed',
        provider,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_SESSION_CORRUPT' });

    const v1: EchoEvent = {
      id: 'event-1',
      sequence: 1,
      timestamp: '2026-08-29T00:00:00.000Z',
      sessionId: 'session-v1-delta',
      type: 'session.started',
      payload: { workspace: '.', safetyMode: 'balanced' },
    };
    await store.append(v1);
    await store.append({
      id: 'event-2',
      sequence: 2,
      timestamp: '2026-08-29T00:00:00.000Z',
      sessionId: 'session-v1-delta',
      turnId: 'turn-1',
      stepId: 'step-1',
      type: 'model.text_delta',
      payload: { delta: 'p0 body' },
    });
    const restored: EchoEvent[] = [];
    for await (const item of store.read('session-v1-delta')) restored.push(item);
    expect(restored.some((event) => event.type === 'model.text_delta')).toBe(true);
    expect(EVENT_SCHEMA_VERSION_P0).toBe(1);
  });
});
