import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { ActiveTurnCoordinator, EchoApplicationService } from '../../../src/application/index.js';
import type { SessionEventHub } from '../../../src/web/sse-hub.js';
import { writePersistentConfigFile } from '../../../src/config/index.js';
import { EventContextBuilder } from '../../../src/context/index.js';
import type {
  EchoEvent,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  SafetyPolicy,
  ToolDefinition,
} from '../../../src/contracts/index.js';
import { cancellationError } from '../../../src/provider/errors.js';
import { FakeProvider } from '../../../src/provider/index.js';
import { createProviderIdentity, JsonlSessionRepository } from '../../../src/session/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';
import { createProviderConfigService } from '../../../src/config/index.js';
import {
  WEB_AUTH_COOKIE,
  WEB_BODY_LIMIT_BYTES,
  WEB_SERVER_HOST,
  WEB_SHUTDOWN_TIMEOUT_MS,
  createSessionEventHub,
  registerSessionApiRoutes,
  registerWebRequestGuards,
  type WebGuardState,
} from '../../../src/web/server/index.js';
import { hexToken } from '../../../src/web/server/http.js';

export const TEST_REQUEST_ID = 'req_0123456789abcd';

export class GatedProvider implements ModelProvider {
  readonly name: string;
  private readonly inner: FakeProvider;
  private readonly gate: Promise<void>;

  constructor(inner: FakeProvider, gate: Promise<void>) {
    this.inner = inner;
    this.gate = gate;
    this.name = inner.name;
  }

  stream(
    request: ModelRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<ModelStreamEvent> {
    const inner = this.inner.stream(request, options);
    const gate = this.gate;
    return (async function* gated() {
      if (options.signal.aborted) {
        throw cancellationError('The gated model request was cancelled.');
      }
      await Promise.race([
        gate,
        new Promise<never>((_, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(cancellationError('The gated model request was cancelled.'));
            },
            { once: true },
          );
        }),
      ]);
      yield* inner;
    })();
  }

  listModelIds(options: Readonly<{ signal: AbortSignal; timeoutMs?: number }>) {
    return this.inner.listModelIds(options);
  }
}

export function inspectTool(): ToolDefinition<unknown, { value: string }> {
  return {
    name: 'inspect',
    description: 'test tool',
    inputSchema: { type: 'object' },
    execute: async () => ({
      status: 'completed',
      summary: 'inspected',
      data: { value: 'observation' },
      truncated: false,
    }),
  };
}

export const askPolicy: SafetyPolicy = {
  evaluate: async () => ({
    action: 'ask',
    reason: 'confirm test operation',
    approvalKey: 'approval-key',
    ruleId: 'policy.test.ask',
  }),
};

export interface SessionApiHarnessOptions {
  readonly provider?: ModelProvider;
  readonly policy?: SafetyPolicy;
  readonly tools?: readonly ToolDefinition<unknown>[];
  readonly heartbeatIntervalMs?: number;
}

export interface SessionApiHarness {
  readonly app: FastifyInstance;
  readonly workspaceRoot: string;
  readonly origin: string;
  readonly host: string;
  readonly cookie: string;
  readonly identity: ReturnType<typeof createProviderIdentity>;
  readonly coordinator: ActiveTurnCoordinator;
  readonly service: EchoApplicationService;
  readonly hub: SessionEventHub;
  beginStop(): void;
  requestId(suffix: string): string;
  inject(options: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly payload?: unknown;
    readonly cookies?: string | false;
  }): Promise<{
    readonly statusCode: number;
    readonly headers: OutgoingHttpHeaders;
    readonly body: string;
    json(): unknown;
  }>;
  close(): Promise<void>;
}

const temporaryDirectories: string[] = [];

export async function startSessionApiHarness(
  options: SessionApiHarnessOptions = {},
): Promise<SessionApiHarness> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'echo-p2b1-ws-'));
  const artifactRoot = await mkdtemp(path.join(tmpdir(), 'echo-p2b1-art-'));
  temporaryDirectories.push(workspaceRoot, artifactRoot);
  await mkdir(path.join(artifactRoot, 'config'), { recursive: true });
  await writePersistentConfigFile(artifactRoot, {
    baseUrl: 'https://provider.example/v1',
    model: 'fake-model',
    modelCatalog: { source: 'discover' },
    safetyMode: 'balanced',
  });

  const identity = createProviderIdentity('https://provider.example/v1');
  const hub = createSessionEventHub();
  const provider =
    options.provider ??
    new FakeProvider([
      {
        events: [
          { type: 'text_delta', delta: 'done' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
  const service = new EchoApplicationService({
    repository: new JsonlSessionRepository({ workspaceRoot }),
    provider,
    providerIdentity: identity,
    tools: new ToolRegistry(options.tools ?? []),
    policy:
      options.policy ??
      ({
        evaluate: async () => ({ action: 'allow', reason: 'allow', ruleId: 'policy.test.allow' }),
      } satisfies SafetyPolicy),
    contextBuilder: new EventContextBuilder({ systemPrompt: 'system constraints' }),
    workspaceRoot,
    maxSteps: 4,
    contextBudget: { maxApproxTokens: 4_000, reservedOutputTokens: 500 },
    toolLimits: { timeoutMs: 1_000, maxOutputChars: 4_000 },
    unattendedApproval: 'wait',
    onEvent: (event: EchoEvent) => {
      hub.publish(event);
    },
    secrets: ['test-key'],
  });
  const coordinator = new ActiveTurnCoordinator({ service, waiter: hub });
  const configService = createProviderConfigService({
    artifactRoot,
    env: { ECHO_API_KEY: 'test-key' },
  });
  const sessionSecret = hexToken(32);
  const state: WebGuardState & { serviceState: 'running' | 'stopping' } = {
    advertisedPort: 0,
    serviceState: 'running',
    sessionSecret,
  };

  const app = Fastify({ logger: false, bodyLimit: WEB_BODY_LIMIT_BYTES, trustProxy: false });
  registerWebRequestGuards(app, state);
  app.setErrorHandler((error: { statusCode?: number; code?: string }, _request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status === 413) {
      reply.status(413).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'The request body is too large.',
          retryable: false,
        },
        requestId: TEST_REQUEST_ID,
      });
      return;
    }
    if (status === 415 || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'State-changing requests must use application/json.',
          retryable: false,
        },
        requestId: TEST_REQUEST_ID,
      });
      return;
    }
    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
        retryable: false,
      },
      requestId: TEST_REQUEST_ID,
    });
  });
  registerSessionApiRoutes(app, {
    application: service,
    coordinator,
    hub,
    configService,
    providerIdentity: identity,
    workspaceRoot,
    state,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 20,
    secrets: ['test-key'],
  });

  await app.listen({ host: WEB_SERVER_HOST, port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('The session API harness did not bind a TCP address.');
  }
  state.advertisedPort = address.port;
  const origin = `http://${WEB_SERVER_HOST}:${String(address.port)}`;
  const host = `${WEB_SERVER_HOST}:${String(address.port)}`;

  return {
    app,
    workspaceRoot,
    origin,
    host,
    cookie: sessionSecret,
    identity,
    coordinator,
    service,
    hub,
    beginStop() {
      state.serviceState = 'stopping';
    },
    requestId(suffix) {
      const padded = `${suffix}xxxxxxxxxxxx`.replaceAll('_', 'x').slice(0, 12);
      return `req_${padded}`;
    },
    inject(input) {
      const headers: Record<string, string> = {
        host,
        ...input.headers,
      };
      if (input.cookies !== false) {
        headers['cookie'] = `${WEB_AUTH_COOKIE}=${input.cookies ?? sessionSecret}`;
      }
      if (input.payload === undefined) {
        return app.inject({ method: input.method, url: input.url, headers });
      }
      return app.inject({
        method: input.method,
        url: input.url,
        headers,
        payload: input.payload as string | object,
      });
    },
    async close() {
      state.serviceState = 'stopping';
      hub.closeStream();
      await coordinator.shutdown(WEB_SHUTDOWN_TIMEOUT_MS);
      await app.close();
    },
  };
}

export async function cleanupSessionApiHarnesses(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}
