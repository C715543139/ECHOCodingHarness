import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { ActiveTurnCoordinator } from '../../../src/application/index.js';
import {
  createProviderConfigService,
  writePersistentConfigFile,
} from '../../../src/config/index.js';
import type {
  ApplicationService,
  EchoEvent,
  SessionQueryView,
} from '../../../src/contracts/index.js';
import { createProviderIdentity } from '../../../src/session/index.js';
import { toQueryView } from '../../../src/session/session-query.js';
import {
  WEB_AUTH_COOKIE,
  WEB_BODY_LIMIT_BYTES,
  WEB_SERVER_HOST,
  createSessionEventHub,
  registerSessionApiRoutes,
  registerWebRequestGuards,
  type WebGuardState,
} from '../../../src/web/server/index.js';
import { hexToken } from '../../../src/web/server/http.js';

const PROVIDER = createProviderIdentity('https://provider.example/v1');

function started(sessionId: string): EchoEvent {
  return {
    id: 'event-1',
    sequence: 1,
    timestamp: '2026-08-30T00:00:01.000Z',
    sessionId,
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

function resumed(sessionId: string, sequence: number): EchoEvent {
  return {
    id: `event-${String(sequence)}`,
    sequence,
    timestamp: '2026-08-30T00:00:04.000Z',
    sessionId,
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

describe('Session SSE resync', () => {
  it('emits resync.required and closes when backlog cannot be filled continuously', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'echo-p2b1-resync-'));
    const artifactRoot = await mkdtemp(path.join(tmpdir(), 'echo-p2b1-resync-art-'));
    await writePersistentConfigFile(artifactRoot, {
      baseUrl: 'https://provider.example/v1',
      model: 'fake-model',
      modelCatalog: { source: 'discover' },
      safetyMode: 'balanced',
    });
    const sessionId = 'session-resync-1';
    const view: SessionQueryView = toQueryView(sessionId, 'workspace', [
      started(sessionId),
      resumed(sessionId, 4),
    ]);
    const application = {
      getSession: async () => view,
      listSessions: async () => [],
    } as unknown as ApplicationService;
    const hub = createSessionEventHub();
    const coordinator = new ActiveTurnCoordinator({
      service: application,
      waiter: hub,
    });
    const state: WebGuardState = {
      advertisedPort: 0,
      serviceState: 'running',
      sessionSecret: hexToken(32),
    };
    const app = Fastify({ logger: false, bodyLimit: WEB_BODY_LIMIT_BYTES, trustProxy: false });
    registerWebRequestGuards(app, state);
    registerSessionApiRoutes(app, {
      application,
      coordinator,
      hub,
      configService: createProviderConfigService({
        artifactRoot,
        env: { ECHO_API_KEY: 'test-key' },
      }),
      providerIdentity: PROVIDER,
      workspaceRoot,
      state,
      heartbeatIntervalMs: 50,
    });
    await app.listen({ host: WEB_SERVER_HOST, port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    state.advertisedPort = address.port;
    const origin = `http://${WEB_SERVER_HOST}:${String(address.port)}`;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          {
            hostname: WEB_SERVER_HOST,
            port: address.port,
            path: `/api/v1/sessions/${sessionId}/events?after=1`,
            headers: {
              host: `${WEB_SERVER_HOST}:${String(address.port)}`,
              cookie: `${WEB_AUTH_COOKIE}=${state.sessionSecret}`,
            },
          },
          (response) => {
            expect(response.statusCode).toBe(200);
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.on('end', () => resolve(body));
          },
        );
        request.on('error', reject);
        request.end();
      });
      expect(text).toContain('event: resync.required');
      expect(text).toContain('"reason":"history_gap"');
      expect(text).toContain('"lastAvailableSeq":4');
      expect(origin).toContain('127.0.0.1');
    } finally {
      hub.closeStream();
      await app.close();
    }
  });
});
