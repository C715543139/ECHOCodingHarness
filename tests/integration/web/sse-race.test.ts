import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ActiveTurnCoordinator } from '../../../src/application/index.js';
import {
  createProviderConfigService,
  writePersistentConfigFile,
} from '../../../src/config/index.js';
import {
  CONFIG_ERROR_CODES,
  type ApplicationService,
  type EchoEvent,
  type SessionQueryView,
} from '../../../src/contracts/index.js';
import { configurationError } from '../../../src/session/errors.js';
import { createProviderIdentity } from '../../../src/session/index.js';
import { toQueryView } from '../../../src/session/session-query.js';
import {
  WEB_AUTH_COOKIE,
  WEB_BODY_LIMIT_BYTES,
  WEB_SERVER_HOST,
  createSessionEventHub,
  registerSessionApiRoutes,
  registerWebRequestGuards,
  type SessionEventHub,
  type WebGuardState,
} from '../../../src/web/server/index.js';
import { hexToken } from '../../../src/web/server/http.js';

const PROVIDER = createProviderIdentity('https://provider.example/v1');
const SESSION_ID = 'session-race-1';

interface OpenSse {
  readonly request: http.ClientRequest;
  readonly status: number;
  text(): string;
  waitUntil(predicate: (text: string) => boolean, timeoutMs?: number): Promise<void>;
}

interface StubServer {
  readonly origin: string;
  readonly cookie: string;
  readonly hub: SessionEventHub;
  readonly app: FastifyInstance;
  close(): Promise<void>;
  openSse(after?: number): Promise<OpenSse>;
  injectEvents(): Promise<{ readonly statusCode: number; json(): unknown }>;
}

const servers: StubServer[] = [];

function started(sequence = 1): EchoEvent {
  return {
    id: `event-${String(sequence)}`,
    sequence,
    timestamp: `2026-08-30T00:00:0${String(sequence)}.000Z`,
    sessionId: SESSION_ID,
    type: 'session.started',
    payload: {
      workspace: '.',
      safetyMode: 'balanced',
      eventSchemaVersion: 3,
      provider: PROVIDER,
      model: 'fake-model',
    },
  };
}

function resumed(sequence: number): EchoEvent {
  return {
    id: `event-${String(sequence)}`,
    sequence,
    timestamp: `2026-08-30T00:00:0${String(sequence)}.000Z`,
    sessionId: SESSION_ID,
    type: 'session.resumed',
    payload: {
      eventSchemaVersion: 3,
      provider: PROVIDER,
      model: 'fake-model',
      safetyMode: 'balanced',
      turnCount: 0,
    },
  };
}

function seqs(text: string): number[] {
  return [...text.matchAll(/^data: (\{.*\})$/gmu)]
    .map((match) => JSON.parse(match[1] ?? '{}') as { seq?: number })
    .map((payload) => payload.seq)
    .filter((seq): seq is number => typeof seq === 'number');
}

function openSse(url: string, cookie: string): Promise<OpenSse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          host: parsed.host,
          cookie: `${WEB_AUTH_COOKIE}=${cookie}`,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        let text = '';
        const waiters: ((value: string) => void)[] = [];
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
          for (const waiter of waiters.splice(0)) waiter(text);
        });
        response.on('error', reject);
        resolve({
          request,
          status,
          text: () => text,
          waitUntil(predicate, timeoutMs = 5_000) {
            if (predicate(text)) return Promise.resolve();
            return new Promise<void>((done, fail) => {
              const timer = setTimeout(() => {
                fail(new Error(`SSE wait timed out: ${text.slice(0, 500)}`));
              }, timeoutMs);
              const check = (current: string): void => {
                if (!predicate(current)) {
                  waiters.push(check);
                  return;
                }
                clearTimeout(timer);
                done();
              };
              waiters.push(check);
            });
          },
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function startStub(input: {
  readonly getSession: ApplicationService['getSession'];
  readonly hub?: SessionEventHub;
  readonly heartbeatIntervalMs?: number;
}): Promise<StubServer> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'echo-p2b1-race-'));
  const artifactRoot = await mkdtemp(path.join(tmpdir(), 'echo-p2b1-race-art-'));
  await writePersistentConfigFile(artifactRoot, {
    baseUrl: 'https://provider.example/v1',
    model: 'fake-model',
    modelCatalog: { source: 'discover' },
    safetyMode: 'balanced',
  });
  const hub = input.hub ?? createSessionEventHub();
  const application = {
    getSession: input.getSession,
    listSessions: async () => [],
  } as unknown as ApplicationService;
  const cookie = hexToken(32);
  const state: WebGuardState = {
    advertisedPort: 0,
    serviceState: 'running',
    sessionSecret: cookie,
  };
  const app = Fastify({ logger: false, bodyLimit: WEB_BODY_LIMIT_BYTES, trustProxy: false });
  registerWebRequestGuards(app, state);
  registerSessionApiRoutes(app, {
    application,
    coordinator: new ActiveTurnCoordinator({ service: application, waiter: hub }),
    hub,
    configService: createProviderConfigService({
      artifactRoot,
      env: { ECHO_API_KEY: 'test-key' },
    }),
    providerIdentity: PROVIDER,
    workspaceRoot,
    state,
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? 20,
  });
  await app.listen({ host: WEB_SERVER_HOST, port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('The SSE race stub did not bind a TCP address.');
  }
  state.advertisedPort = address.port;
  const origin = `http://${WEB_SERVER_HOST}:${String(address.port)}`;
  const server: StubServer = {
    origin,
    cookie,
    hub,
    app,
    async close() {
      hub.closeStream();
      await app.close();
    },
    openSse(after = 0) {
      return openSse(
        `${origin}/api/v1/sessions/${SESSION_ID}/events?after=${String(after)}`,
        cookie,
      );
    },
    injectEvents() {
      return app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${SESSION_ID}/events?after=0`,
        headers: {
          host: `${WEB_SERVER_HOST}:${String(address.port)}`,
          cookie: `${WEB_AUTH_COOKIE}=${cookie}`,
        },
      });
    },
  };
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('Session SSE subscribe-buffer-snapshot-drain races', () => {
  it('emits buffered events missing from the snapshot once and keeps live seq contiguous', async () => {
    const snapshot: SessionQueryView = toQueryView(SESSION_ID, 'workspace', [
      started(1),
      resumed(2),
    ]);
    const hub = createSessionEventHub();
    const server = await startStub({
      hub,
      getSession: async () => {
        hub.publish(resumed(2));
        hub.publish(resumed(3));
        return snapshot;
      },
      heartbeatIntervalMs: 15,
    });
    const stream = await server.openSse(0);
    expect(stream.status).toBe(200);
    await stream.waitUntil((text) => seqs(text).includes(3) && text.includes('event: heartbeat'));
    expect(seqs(stream.text())).toEqual([1, 2, 3]);
    expect(stream.text()).not.toMatch(/^id:.*\nevent: heartbeat/mu);

    server.hub.publish(resumed(4));
    await stream.waitUntil((text) => seqs(text).includes(4));
    expect(seqs(stream.text())).toEqual([1, 2, 3, 4]);
    stream.request.destroy();
  });

  it('rejects a concurrent SSE with 409 STREAM_ACTIVE before hijack while the first snapshot is gated', async () => {
    const snapshot: SessionQueryView = toQueryView(SESSION_ID, 'workspace', [started(1)]);
    let releaseRead!: () => void;
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    const server = await startStub({
      getSession: async () => {
        reads += 1;
        if (reads === 1) notifyEntered();
        await gate;
        return snapshot;
      },
    });
    const firstPromise = server.openSse(0);
    const secondPromise = server.openSse(0);
    await entered;
    releaseRead();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const statuses = [first.status, second.status].toSorted((left, right) => left - right);
    expect(statuses).toEqual([200, 409]);
    expect(reads).toBe(1);
    const loser = first.status === 409 ? first : second;
    const winner = first.status === 200 ? first : second;
    await loser.waitUntil((text) => text.includes('STREAM_ACTIVE'));
    expect(JSON.parse(loser.text()) as { error: { code: string } }).toMatchObject({
      error: { code: 'STREAM_ACTIVE' },
    });
    await winner.waitUntil((text) => seqs(text).includes(1));
    winner.request.destroy();
    loser.request.destroy();
  });

  it('releases the lease when snapshot load fails so a later stream can connect', async () => {
    const snapshot: SessionQueryView = toQueryView(SESSION_ID, 'workspace', [started(1)]);
    let fail = true;
    const server = await startStub({
      getSession: async () => {
        if (fail) {
          fail = false;
          throw configurationError(
            CONFIG_ERROR_CODES.sessionNotFound,
            'The requested session does not exist in this workspace.',
          );
        }
        return snapshot;
      },
    });
    const failed = await server.injectEvents();
    expect(failed.statusCode).toBe(404);
    expect(failed.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const stream = await server.openSse(0);
    expect(stream.status).toBe(200);
    await stream.waitUntil((text) => seqs(text).includes(1));
    stream.request.destroy();
  });

  it('releases the lease when the client disconnects during snapshot load', async () => {
    const snapshot: SessionQueryView = toQueryView(SESSION_ID, 'workspace', [started(1)]);
    let releaseRead!: () => void;
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const server = await startStub({
      getSession: async () => {
        notifyEntered();
        await gate;
        return snapshot;
      },
    });
    const parsed = new URL(`${server.origin}/api/v1/sessions/${SESSION_ID}/events?after=0`);
    const dropped = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          host: parsed.host,
          cookie: `${WEB_AUTH_COOKIE}=${server.cookie}`,
        },
      },
      () => undefined,
    );
    dropped.on('error', () => undefined);
    dropped.end();
    await entered;
    dropped.destroy();
    await expect.poll(() => server.hub.currentStream() === undefined).toBe(true);
    releaseRead();
    const stream = await server.openSse(0);
    expect(stream.status).toBe(200);
    await stream.waitUntil((text) => seqs(text).includes(1));
    stream.request.destroy();
  });
});
