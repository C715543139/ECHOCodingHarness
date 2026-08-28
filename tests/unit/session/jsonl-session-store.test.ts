import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { EchoEvent } from '../../../src/contracts/index.js';
import { JsonlSessionStore } from '../../../src/session/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-session-'));
  temporaryDirectories.push(directory);
  return directory;
}

function event(sequence: number, goal: string): EchoEvent {
  return {
    id: `event-${String(sequence)}`,
    sequence,
    timestamp: '2026-08-28T00:00:00.000Z',
    sessionId: 'session-test',
    turnId: 'turn-test',
    type: 'turn.started',
    payload: { goal },
  };
}

describe('JsonlSessionStore', () => {
  it('appends and reads one ordered JSON object per line', async () => {
    const workspace = await temporaryWorkspace();
    const store = new JsonlSessionStore({ workspaceRoot: workspace });

    await Promise.all([store.append(event(1, 'first')), store.append(event(2, 'second'))]);

    const restored: EchoEvent[] = [];
    for await (const item of store.read('session-test')) restored.push(item);
    expect(restored).toEqual([event(1, 'first'), event(2, 'second')]);

    const text = await fs.readFile(
      path.join(workspace, '.echo', 'sessions', 'session-test.jsonl'),
      'utf8',
    );
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  it('redacts configured secrets, authorization values, home paths, and causes before writing', async () => {
    const workspace = await temporaryWorkspace();
    const store = new JsonlSessionStore({
      workspaceRoot: workspace,
      secrets: ['secret-value-123'],
      homeDirectory: 'C:\\Users\\private-user',
    });
    const unsafe = {
      ...event(1, 'Authorization: Bearer abc.def.ghi secret-value-123 C:/Users/private-user/x'),
      payload: {
        error: {
          category: 'internal',
          code: 'BROKEN',
          message: 'Authorization: Bearer abc.def.ghi secret-value-123',
          retryable: false,
          cause: new Error('private cause'),
        },
      },
      type: 'model.failed',
    } as EchoEvent;

    await store.append(unsafe);

    const persisted = await fs.readFile(
      path.join(workspace, '.echo', 'sessions', 'session-test.jsonl'),
      'utf8',
    );
    expect(persisted).not.toContain('secret-value-123');
    expect(persisted).not.toContain('abc.def.ghi');
    expect(persisted).not.toContain('private-user');
    expect(persisted).not.toContain('private cause');
    expect(persisted).toContain('[REDACTED]');
  });

  it('rejects invalid session identifiers and non-increasing sequences', async () => {
    const workspace = await temporaryWorkspace();
    const store = new JsonlSessionStore({ workspaceRoot: workspace });

    await expect(
      store.append({ ...event(1, 'bad'), sessionId: '../escape' }),
    ).rejects.toMatchObject({
      category: 'storage',
    });
    await store.append(event(2, 'first'));
    await expect(store.append(event(2, 'duplicate'))).rejects.toMatchObject({
      category: 'storage',
    });
  });

  it('refuses to follow a linked session directory outside the workspace', async () => {
    const root = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await fs.symlink(
      outside,
      path.join(root, '.echo'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const store = new JsonlSessionStore({ workspaceRoot: root });

    await expect(store.append(event(1, 'safe goal'))).rejects.toMatchObject({
      category: 'storage',
      code: 'SESSION_PATH_UNSAFE',
    });
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });
});
