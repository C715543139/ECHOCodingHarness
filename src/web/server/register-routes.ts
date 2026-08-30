import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { ProviderConfigService } from '../../config/index.js';
import { WEB_JSON_SCHEMAS, type BootstrapDto } from '../../contracts/index.js';
import { validateWebJsonSchema } from '../../contracts/web-schema.js';
import { projectRuntimeCapabilities, type WebServiceState } from '../runtime-capabilities.js';

import {
  WEB_AUTH_COOKIE,
  WEB_CSP,
  hexToken,
  isApiPath,
  requestIdOf,
  sendError,
  toProviderDto,
} from './http.js';

export interface WebSseOwner {
  readonly reply: FastifyReply;
  timer: ReturnType<typeof setInterval> | undefined;
}

export interface WebAdapterState {
  advertisedPort: number;
  serviceState: WebServiceState;
  tokenRedeemed: boolean;
  sessionSecret: string | undefined;
  sseOwner: WebSseOwner | undefined;
}

export interface WebRouteDependencies {
  readonly workspace: { readonly name: string; readonly fingerprint: string };
  readonly bootstrapToken: string;
  readonly configService: ProviderConfigService;
  readonly heartbeatIntervalMs: number;
  readonly assetRoot: string | undefined;
  readonly state: WebAdapterState;
}

export async function registerWebRoutes(
  app: FastifyInstance,
  deps: WebRouteDependencies,
): Promise<void> {
  const { workspace, bootstrapToken, configService, heartbeatIntervalMs, assetRoot, state } = deps;

  app.post('/api/v1/auth/bootstrap', async (request, reply) => {
    const errors = validateWebJsonSchema(
      {
        type: 'object',
        additionalProperties: false,
        required: ['token'],
        properties: { token: { type: 'string', minLength: 16, maxLength: 128 } },
      },
      request.body,
    );
    if (errors.length > 0) {
      sendError(reply, request, 401, 'AUTH_INVALID', 'Authentication failed.');
      return;
    }
    const token = (request.body as { token: string }).token;
    if (state.tokenRedeemed || token !== bootstrapToken || state.serviceState === 'stopping') {
      sendError(reply, request, 401, 'AUTH_INVALID', 'Authentication failed.');
      return;
    }
    state.tokenRedeemed = true;
    state.sessionSecret = hexToken(32);
    void reply
      .status(204)
      .header(
        'Set-Cookie',
        `${WEB_AUTH_COOKIE}=${state.sessionSecret}; HttpOnly; SameSite=Strict; Path=/api/v1`,
      )
      .send();
  });

  app.get('/api/v1/bootstrap', async (request, reply) => {
    const read = await configService.read();
    if (!read.ok) {
      sendError(
        reply,
        request,
        503,
        'PROVIDER_UNAVAILABLE',
        'Provider configuration is unavailable.',
      );
      return;
    }
    const writable = state.serviceState === 'running';
    const data: BootstrapDto = {
      workspace,
      provider: toProviderDto(read.value, writable),
      capabilities: projectRuntimeCapabilities({
        serviceState: state.serviceState,
        providerAvailable: read.value.apiKeyConfigured,
        selectedSessionAvailable: false,
        awaitingApproval: false,
      }),
    };
    const schemaErrors = validateWebJsonSchema(WEB_JSON_SCHEMAS.bootstrap, data);
    if (schemaErrors.length > 0) {
      sendError(reply, request, 500, 'INTERNAL_ERROR', 'The bootstrap payload could not be built.');
      return;
    }
    void reply.status(200).send({ data, requestId: requestIdOf(request) });
  });

  app.get('/api/v1/sessions/:sessionId/events', async (request, reply) => {
    if (state.sseOwner !== undefined) {
      sendError(
        reply,
        request,
        409,
        'STREAM_ACTIVE',
        'This authentication cookie already has an active stream.',
      );
      return;
    }
    const owner: WebSseOwner = { reply, timer: undefined };
    state.sseOwner = owner;
    void reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Security-Policy': WEB_CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    const release = (): void => {
      if (state.sseOwner !== owner) return;
      if (owner.timer !== undefined) clearInterval(owner.timer);
      owner.timer = undefined;
      state.sseOwner = undefined;
    };
    const writeHeartbeat = (): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        release();
        return;
      }
      try {
        reply.raw.write('event: heartbeat\ndata: {}\n\n');
      } catch {
        release();
      }
    };
    writeHeartbeat();
    owner.timer = setInterval(writeHeartbeat, heartbeatIntervalMs);
    request.raw.once('close', release);
    request.raw.once('aborted', release);
    request.raw.socket?.once('close', release);
    reply.raw.once('close', release);
    reply.raw.once('finish', release);
    reply.raw.once('error', release);
  });

  app.setNotFoundHandler((request, reply) => {
    if (isApiPath(request.url)) {
      sendError(reply, request, 404, 'NOT_FOUND', 'The requested resource was not found.');
      return;
    }
    void reply.status(404).type('text/plain').send('Not found');
  });

  app.setErrorHandler((error: { statusCode?: number; code?: string }, request, reply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    const code = typeof error.code === 'string' ? error.code : '';
    if (status === 413) {
      sendError(reply, request, 413, 'INVALID_REQUEST', 'The request body is too large.');
      return;
    }
    if (
      status === 415 ||
      code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      sendError(
        reply,
        request,
        400,
        'INVALID_REQUEST',
        'State-changing requests must use application/json.',
      );
      return;
    }
    sendError(reply, request, 500, 'INTERNAL_ERROR', 'The request could not be completed.');
  });

  if (assetRoot === undefined) {
    return;
  }
  try {
    await access(assetRoot);
    await app.register(fastifyStatic, {
      root: assetRoot,
      wildcard: false,
    });
    app.get('/', async (_request, reply) => {
      const index = path.join(assetRoot, 'index.html');
      return reply.type('text/html').send(createReadStream(index));
    });
  } catch {
    // Tests may omit packaged assets; API-only mode remains valid.
  }
}
