import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { EchoEvent, SessionId, SessionStore } from '../contracts/index.js';

import { isStorageError, storageError } from './errors.js';
import { redactValue, type RedactionOptions } from './redaction.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface JsonlSessionStoreOptions extends RedactionOptions {
  readonly workspaceRoot: string;
  readonly sessionsDirectory?: string;
}

function assertSessionId(sessionId: SessionId): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw storageError('INVALID_SESSION_ID', 'The session identifier is not safe for storage.');
  }
}

function isEchoEvent(value: unknown): value is EchoEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['sequence'] === 'number' &&
    Number.isSafeInteger(record['sequence']) &&
    typeof record['timestamp'] === 'string' &&
    typeof record['sessionId'] === 'string' &&
    typeof record['type'] === 'string' &&
    typeof record['payload'] === 'object' &&
    record['payload'] !== null
  );
}

export class JsonlSessionStore implements SessionStore {
  protected readonly workspaceRoot: string;
  protected readonly sessionsDirectory: string;
  private readonly redactionOptions: RedactionOptions;
  private readonly queues = new Map<SessionId, Promise<void>>();
  private readonly lastSequences = new Map<SessionId, number>();

  constructor(options: JsonlSessionStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.sessionsDirectory =
      options.sessionsDirectory === undefined
        ? path.join(this.workspaceRoot, '.echo', 'sessions')
        : path.resolve(options.sessionsDirectory);
    const relative = path.relative(this.workspaceRoot, this.sessionsDirectory);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw storageError(
        'SESSION_DIRECTORY_OUTSIDE_WORKSPACE',
        'The session directory must be a child of the fixed workspace.',
      );
    }
    this.redactionOptions = {
      workspaceRoot: this.workspaceRoot,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    };
  }

  append(event: EchoEvent): Promise<void> {
    try {
      assertSessionId(event.sessionId);
    } catch (error) {
      return Promise.reject(error);
    }
    const previous = this.queues.get(event.sessionId) ?? Promise.resolve();
    const next = previous.then(() => this.appendOrdered(event));
    this.queues.set(
      event.sessionId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async appendOrdered(event: EchoEvent): Promise<void> {
    try {
      const lastSequence =
        this.lastSequences.get(event.sessionId) ?? (await this.readLastSequence(event.sessionId));
      if (event.sequence <= lastSequence) {
        throw storageError(
          'EVENT_SEQUENCE_OUT_OF_ORDER',
          'Session event sequence must be strictly increasing.',
        );
      }
      const safeEvent = redactValue(event, this.redactionOptions);
      const line = `${JSON.stringify(safeEvent)}\n`;
      await this.prepareSessionsDirectory();
      await this.assertRegularSessionFile(event.sessionId, true);
      await this.replaceWithAppendedLine(event.sessionId, line);
      this.lastSequences.set(event.sessionId, event.sequence);
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw storageError(
        'SESSION_APPEND_FAILED',
        'The session event could not be persisted.',
        error,
      );
    }
  }

  async *read(sessionId: SessionId): AsyncIterable<EchoEvent> {
    assertSessionId(sessionId);
    let text: string;
    try {
      await this.prepareSessionsDirectory(false);
      await this.assertRegularSessionFile(sessionId, false);
      text = await fs.readFile(this.filePath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (isStorageError(error)) throw error;
      throw storageError('SESSION_READ_FAILED', 'The session event log could not be read.', error);
    }

    let previousSequence = 0;
    for (const line of text.split(/\r?\n/u)) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw storageError(
          'SESSION_LOG_INVALID',
          'The session event log contains invalid JSON.',
          error,
        );
      }
      if (
        !isEchoEvent(parsed) ||
        parsed.sessionId !== sessionId ||
        parsed.sequence <= previousSequence
      ) {
        throw storageError(
          'SESSION_LOG_INVALID',
          'The session event log contains an invalid or out-of-order event.',
        );
      }
      previousSequence = parsed.sequence;
      yield parsed;
    }
  }

  async listSessionIds(): Promise<readonly SessionId[]> {
    try {
      await this.prepareSessionsDirectory(false);
      const entries = await fs.readdir(this.sessionsDirectory, { withFileTypes: true });
      return entries
        .filter(
          (entry) =>
            entry.isFile() &&
            !entry.name.startsWith('.') &&
            entry.name.endsWith('.jsonl') &&
            !entry.name.endsWith('.tmp.jsonl'),
        )
        .map((entry) => entry.name.slice(0, -'.jsonl'.length))
        .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (isStorageError(error)) throw error;
      throw storageError(
        'SESSION_LIST_FAILED',
        'The session directory could not be listed.',
        error,
      );
    }
  }

  private filePath(sessionId: SessionId): string {
    return path.join(this.sessionsDirectory, `${sessionId}.jsonl`);
  }

  private async readLastSequence(sessionId: SessionId): Promise<number> {
    let last = 0;
    for await (const event of this.read(sessionId)) last = event.sequence;
    return last;
  }

  private async prepareSessionsDirectory(create = true): Promise<void> {
    const relative = path.relative(this.workspaceRoot, this.sessionsDirectory);
    let current = this.workspaceRoot;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw storageError(
            'SESSION_PATH_UNSAFE',
            'The session directory contains a link or non-directory component.',
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    if (create) await fs.mkdir(this.sessionsDirectory, { recursive: true });
    let realDirectory: string;
    let realRoot: string;
    try {
      [realDirectory, realRoot] = await Promise.all([
        fs.realpath(this.sessionsDirectory),
        fs.realpath(this.workspaceRoot),
      ]);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const realRelative = path.relative(realRoot, realDirectory);
    if (
      realRelative === '' ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      throw storageError(
        'SESSION_PATH_UNSAFE',
        'The session directory resolves outside the fixed workspace.',
      );
    }
  }

  private async assertRegularSessionFile(
    sessionId: SessionId,
    allowMissing: boolean,
  ): Promise<void> {
    try {
      const stat = await fs.lstat(this.filePath(sessionId));
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw storageError(
          'SESSION_PATH_UNSAFE',
          'The session event log must be a regular workspace file.',
        );
      }
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async replaceWithAppendedLine(sessionId: SessionId, line: string): Promise<void> {
    const destination = this.filePath(sessionId);
    let existing = '';
    try {
      existing = await fs.readFile(destination, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = path.join(this.sessionsDirectory, `.${sessionId}.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(`${existing}${line}`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
