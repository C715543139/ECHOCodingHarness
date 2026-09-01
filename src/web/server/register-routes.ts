import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import type { ProviderConfigService } from '../../config/index.js';
import { WEB_JSON_SCHEMAS, type BootstrapDto } from '../../contracts/index.js';
import { validateWebJsonSchema } from '../../contracts/web-schema.js';
import { projectRuntimeCapabilities, type WebServiceState } from '../runtime-capabilities.js';

import {
  WEB_AUTH_COOKIE,
  hexToken,
  isApiPath,
  requestIdOf,
  sendError,
  toProviderDto,
} from './http.js';
import { registerProviderApiRoutes } from './provider-api.js';
import { registerExtensionApiRoutes, type ExtensionAdministrationPort } from './extension-api.js';
import { registerSessionApiRoutes, type SessionApiDependencies } from './session-api.js';

export interface WebAdapterState {
  advertisedPort: number;
  serviceState: WebServiceState;
  tokenRedeemed: boolean;
  sessionSecret: string | undefined;
}

export interface WebRouteDependencies {
  readonly workspace: { readonly name: string; readonly fingerprint: string };
  readonly bootstrapToken: string;
  readonly configService: ProviderConfigService;
  readonly heartbeatIntervalMs: number;
  readonly assetRoot: string | undefined;
  readonly state: WebAdapterState;
  readonly sessionApi: Omit<SessionApiDependencies, 'state' | 'heartbeatIntervalMs'>;
  readonly extensionAdministration?: ExtensionAdministrationPort;
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
    const active = deps.sessionApi.coordinator.snapshot();
    const data: BootstrapDto = {
      workspace,
      provider: toProviderDto(read.value, writable && active.sessionId === undefined),
      capabilities: projectRuntimeCapabilities({
        serviceState: state.serviceState,
        providerAvailable: read.value.apiKeyConfigured,
        selectedSessionAvailable: false,
        awaitingApproval: false,
        ...(active.sessionId === undefined ? {} : { activeSessionId: active.sessionId }),
        ...(active.turnId === undefined ? {} : { activeTurnId: active.turnId }),
      }),
    };
    const schemaErrors = validateWebJsonSchema(WEB_JSON_SCHEMAS.bootstrap, data);
    if (schemaErrors.length > 0) {
      sendError(reply, request, 500, 'INTERNAL_ERROR', 'The bootstrap payload could not be built.');
      return;
    }
    void reply.status(200).send({ data, requestId: requestIdOf(request) });
  });

  registerProviderApiRoutes(app, {
    configService,
    coordinator: deps.sessionApi.coordinator,
    state,
  });
  registerSessionApiRoutes(app, {
    ...deps.sessionApi,
    state,
    heartbeatIntervalMs,
  });
  registerExtensionApiRoutes(app, {
    ...(deps.extensionAdministration === undefined
      ? {}
      : { administration: deps.extensionAdministration }),
    redaction: {
      workspaceRoot: deps.sessionApi.workspaceRoot,
      ...(deps.sessionApi.secrets === undefined ? {} : { secrets: deps.sessionApi.secrets }),
      ...(deps.sessionApi.homeDirectory === undefined
        ? {}
        : { homeDirectory: deps.sessionApi.homeDirectory }),
    },
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
    const indexHtml = await readFile(path.join(assetRoot, 'index.html'), 'utf8');
    await app.register(fastifyStatic, {
      root: assetRoot,
      index: false,
      wildcard: false,
    });
    app.get('/', async (_request, reply) => {
      return reply.type('text/html').send(indexHtml);
    });
  } catch {
    // Tests may omit packaged assets; API-only mode remains valid.
  }
}
