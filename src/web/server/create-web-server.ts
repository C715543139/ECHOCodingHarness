import { createHash } from 'node:crypto';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { workspaceDisplayName } from '../../cli/chat-view.js';
import { createProviderConfigService, type ProviderConfigService } from '../../config/index.js';
import { isValidRequestId, isValidWorkspaceDisplayName } from '../../contracts/index.js';

import {
  WEB_ASSET_SUBDIRECTORY,
  WEB_AUTH_COOKIE,
  WEB_BODY_LIMIT_BYTES,
  WEB_SERVER_HOST,
  WEB_SHUTDOWN_TIMEOUT_MS,
  applySecurityHeaders,
  expectedHost,
  expectedOrigin,
  hasForbiddenPathField,
  headerValue,
  hexToken,
  isApiPath,
  isBootstrapPath,
  isMutating,
  parseCookie,
  sendError,
} from './http.js';
import { createProductionRuntime } from './production-runtime.js';
import { registerWebRoutes, type WebAdapterState } from './register-routes.js';
import type { ExtensionAdministrationPort } from './extension-api.js';

export {
  WEB_ASSET_SUBDIRECTORY,
  WEB_AUTH_COOKIE,
  WEB_BODY_LIMIT_BYTES,
  WEB_SERVER_HOST,
  WEB_SHUTDOWN_TIMEOUT_MS,
} from './http.js';

export interface CreateWebServerOptions {
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
  readonly assetRoot?: string;
  readonly port?: number;
  readonly env?: Record<string, string | undefined>;
  readonly configService?: ProviderConfigService;
  readonly heartbeatIntervalMs?: number;
  readonly extensionAdministration?: ExtensionAdministrationPort;
}

export interface StartedWebServer {
  readonly host: typeof WEB_SERVER_HOST;
  readonly port: number;
  readonly bootstrapToken: string;
  readonly bootstrapUrl: string;
  readonly app: FastifyInstance;
  close(timeoutMs?: number): Promise<void>;
}

function workspaceFingerprint(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot, 'utf8').digest('hex').slice(0, 32);
}

function workspaceSummary(workspaceRoot: string): { name: string; fingerprint: string } {
  const raw = workspaceDisplayName(workspaceRoot);
  const name = isValidWorkspaceDisplayName(raw) ? raw : 'workspace';
  return { name, fingerprint: workspaceFingerprint(workspaceRoot) };
}

export async function createWebServer(options: CreateWebServerOptions): Promise<StartedWebServer> {
  const port = options.port ?? 0;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const configService =
    options.configService ??
    createProviderConfigService({
      artifactRoot: options.artifactRoot,
      env: options.env ?? process.env,
    });
  const workspace = workspaceSummary(options.workspaceRoot);
  const runtime = await createProductionRuntime({
    workspaceRoot: options.workspaceRoot,
    env: options.env ?? process.env,
    configService,
  });
  const bootstrapToken = hexToken(32);
  const state: WebAdapterState = {
    advertisedPort: port,
    serviceState: 'running',
    tokenRedeemed: false,
    sessionSecret: undefined,
  };

  const app = Fastify({
    logger: false,
    bodyLimit: WEB_BODY_LIMIT_BYTES,
    trustProxy: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(reply, isApiPath(request.url));
    if (!isApiPath(request.url)) return;

    if (
      state.advertisedPort > 0 &&
      headerValue(request.headers.host) !== expectedHost(state.advertisedPort)
    ) {
      sendError(reply, request, 401, 'AUTH_INVALID', 'Authentication failed.');
      return reply;
    }

    const origin = headerValue(request.headers.origin);
    if (
      origin === 'null' ||
      (origin.length > 0 && origin !== expectedOrigin(state.advertisedPort))
    ) {
      sendError(reply, request, 403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
      return reply;
    }
    if (isMutating(request.method) && origin.length === 0) {
      sendError(reply, request, 403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
      return reply;
    }

    if (hasForbiddenPathField(request.query)) {
      sendError(
        reply,
        request,
        400,
        'WORKSPACE_MISMATCH',
        'The API does not accept workspace paths.',
      );
      return reply;
    }

    if (isBootstrapPath(request.url)) return;

    const cookie = parseCookie(headerValue(request.headers.cookie), WEB_AUTH_COOKIE);
    if (state.sessionSecret === undefined || cookie !== state.sessionSecret) {
      sendError(reply, request, 401, 'AUTH_INVALID', 'Authentication failed.');
      return reply;
    }
  });

  app.addHook('preValidation', async (request, reply) => {
    if (!isApiPath(request.url) || !isMutating(request.method)) return;
    if (isBootstrapPath(request.url) === false && state.serviceState === 'stopping') {
      sendError(reply, request, 400, 'INVALID_REQUEST', 'The service is stopping.');
      return reply;
    }
    const contentType = headerValue(request.headers['content-type']).toLowerCase();
    if (!contentType.startsWith('application/json')) {
      sendError(
        reply,
        request,
        400,
        'INVALID_REQUEST',
        'State-changing requests must use application/json.',
      );
      return reply;
    }
    if (!isBootstrapPath(request.url)) {
      const requestId = headerValue(request.headers['x-echo-request-id']);
      if (!isValidRequestId(requestId)) {
        sendError(reply, request, 400, 'INVALID_REQUEST', 'A valid request id is required.');
        return reply;
      }
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!isApiPath(request.url) || request.body === undefined) return;
    if (hasForbiddenPathField(request.body)) {
      sendError(
        reply,
        request,
        400,
        'WORKSPACE_MISMATCH',
        'The API does not accept workspace paths.',
      );
      return reply;
    }
  });

  await registerWebRoutes(app, {
    workspace,
    bootstrapToken,
    configService,
    heartbeatIntervalMs,
    assetRoot: options.assetRoot,
    state,
    sessionApi: runtime.sessionApi,
    ...(options.extensionAdministration === undefined
      ? {}
      : { extensionAdministration: options.extensionAdministration }),
  });

  await app.listen({ host: WEB_SERVER_HOST, port });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('The web server did not bind a TCP address.');
  }
  state.advertisedPort = address.port;
  if (address.address !== WEB_SERVER_HOST && address.address !== '127.0.0.1') {
    await app.close();
    throw new Error('The web server must listen on 127.0.0.1.');
  }

  const close = async (timeoutMs = WEB_SHUTDOWN_TIMEOUT_MS): Promise<void> => {
    state.serviceState = 'stopping';
    runtime.sessionApi.hub.closeStream();
    await runtime.sessionApi.coordinator.shutdown(timeoutMs);
    app.server.closeIdleConnections?.();
    app.server.closeAllConnections?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        app.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Web server shutdown timed out.'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    host: WEB_SERVER_HOST,
    port: state.advertisedPort,
    bootstrapToken,
    bootstrapUrl: `${expectedOrigin(state.advertisedPort)}/#bootstrap=${bootstrapToken}`,
    app,
    close,
  };
}

export function defaultWebAssetRoot(distRoot: string): string {
  return path.join(distRoot, WEB_ASSET_SUBDIRECTORY);
}
