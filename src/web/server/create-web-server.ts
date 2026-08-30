import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { workspaceDisplayName } from '../../cli/chat-view.js';
import { createProviderConfigService, type ProviderConfigService } from '../../config/index.js';
import {
  WEB_JSON_SCHEMAS,
  isValidRequestId,
  isValidWorkspaceDisplayName,
  type ApiErrorResponse,
  type BootstrapDto,
  type ProviderConfigDto,
  type WebErrorCode,
} from '../../contracts/index.js';
import { validateWebJsonSchema } from '../../contracts/web-schema.js';
import { projectRuntimeCapabilities, type WebServiceState } from '../runtime-capabilities.js';

export const WEB_SERVER_HOST = '127.0.0.1' as const;
export const WEB_ASSET_SUBDIRECTORY = 'web' as const;

export const WEB_AUTH_COOKIE = 'echo_web';
export const WEB_BODY_LIMIT_BYTES = 1_048_576;
export const WEB_SHUTDOWN_TIMEOUT_MS = 10_000;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const PATH_FIELD = /^(workspace|workspacePath|workspaceRoot|path|cwd)$/iu;

export interface CreateWebServerOptions {
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
  readonly assetRoot?: string;
  readonly port?: number;
  readonly env?: Record<string, string | undefined>;
  readonly configService?: ProviderConfigService;
  readonly heartbeatIntervalMs?: number;
}

export interface StartedWebServer {
  readonly host: typeof WEB_SERVER_HOST;
  readonly port: number;
  readonly bootstrapToken: string;
  readonly bootstrapUrl: string;
  readonly app: FastifyInstance;
  close(timeoutMs?: number): Promise<void>;
}

function hexToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function workspaceFingerprint(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot, 'utf8').digest('hex').slice(0, 32);
}

function workspaceSummary(workspaceRoot: string): { name: string; fingerprint: string } {
  const raw = workspaceDisplayName(workspaceRoot);
  const name = isValidWorkspaceDisplayName(raw) ? raw : 'workspace';
  return { name, fingerprint: workspaceFingerprint(workspaceRoot) };
}

function expectedOrigin(port: number): string {
  return `http://${WEB_SERVER_HOST}:${String(port)}`;
}

function expectedHost(port: number): string {
  return `${WEB_SERVER_HOST}:${String(port)}`;
}

function headerValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

function requestIdOf(request: FastifyRequest): string {
  const header = headerValue(request.headers['x-echo-request-id']);
  return isValidRequestId(header) ? header : `req_${hexToken(10)}`;
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: WebErrorCode,
  message: string,
  retryable = false,
): void {
  const body: ApiErrorResponse = {
    error: { code, message, retryable },
    requestId: requestIdOf(request),
  };
  void reply.status(status).header('Cache-Control', 'no-store').send(body);
}

function isMutating(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function isBootstrapPath(url: string): boolean {
  return url.split('?')[0] === '/api/v1/auth/bootstrap';
}

function isApiPath(url: string): boolean {
  return url.split('?')[0]?.startsWith('/api/v1') === true;
}

function hasForbiddenPathField(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenPathField(item));
  for (const [key, item] of Object.entries(value)) {
    if (PATH_FIELD.test(key)) return true;
    if (hasForbiddenPathField(item)) return true;
  }
  return false;
}

function toProviderDto(
  snapshot: {
    readonly persistent: {
      readonly baseUrl: string;
      readonly model: string;
      readonly modelCatalog:
        | { readonly source: 'discover' }
        | { readonly source: 'manual'; readonly models: readonly string[] };
    };
    readonly apiKeyConfigured: boolean;
    readonly cachedModels: readonly string[];
  },
  writable: boolean,
): ProviderConfigDto {
  const catalog = snapshot.persistent.modelCatalog;
  return {
    baseUrl: snapshot.persistent.baseUrl,
    catalog:
      catalog.source === 'discover'
        ? { source: 'discover', cachedModels: [...snapshot.cachedModels] }
        : { source: 'manual', models: catalog.models },
    defaultModel: snapshot.persistent.model,
    apiKeyConfigured: snapshot.apiKeyConfigured,
    writable,
  };
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
  const bootstrapToken = hexToken(32);
  let tokenRedeemed = false;
  let sessionSecret: string | undefined;
  let serviceState: WebServiceState = 'running';
  let advertisedPort = port;
  let sseOwner: { readonly reply: FastifyReply; readonly timer: NodeJS.Timeout } | undefined;

  const app = Fastify({
    logger: false,
    bodyLimit: WEB_BODY_LIMIT_BYTES,
    trustProxy: false,
  });

  const securityHeaders = (reply: FastifyReply, api: boolean): void => {
    void reply.header('Content-Security-Policy', CSP);
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('X-Frame-Options', 'DENY');
    if (api) void reply.header('Cache-Control', 'no-store');
  };

  app.addHook('onRequest', async (request, reply) => {
    securityHeaders(reply, isApiPath(request.url));
    if (!isApiPath(request.url)) return;

    if (advertisedPort > 0 && headerValue(request.headers.host) !== expectedHost(advertisedPort)) {
      sendError(reply, request, 401, 'AUTH_INVALID', 'Authentication failed.');
      return reply;
    }

    const origin = headerValue(request.headers.origin);
    if (origin === 'null' || (origin.length > 0 && origin !== expectedOrigin(advertisedPort))) {
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
    if (sessionSecret === undefined || cookie !== sessionSecret) {
      sendError(reply, request, 401, 'AUTH_INVALID', 'Authentication failed.');
      return reply;
    }
  });

  app.addHook('preValidation', async (request, reply) => {
    if (!isApiPath(request.url) || !isMutating(request.method)) return;
    if (isBootstrapPath(request.url) === false && serviceState === 'stopping') {
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
    if (tokenRedeemed || token !== bootstrapToken || serviceState === 'stopping') {
      sendError(reply, request, 401, 'AUTH_INVALID', 'Authentication failed.');
      return;
    }
    tokenRedeemed = true;
    sessionSecret = hexToken(32);
    void reply
      .status(204)
      .header(
        'Set-Cookie',
        `${WEB_AUTH_COOKIE}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/api/v1`,
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
    const writable = serviceState === 'running';
    const data: BootstrapDto = {
      workspace,
      provider: toProviderDto(read.value, writable),
      capabilities: projectRuntimeCapabilities({
        serviceState,
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
    if (sseOwner !== undefined) {
      sendError(
        reply,
        request,
        409,
        'STREAM_ACTIVE',
        'This authentication cookie already has an active stream.',
      );
      return;
    }
    void reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    const release = (): void => {
      if (sseOwner?.reply === reply) {
        clearInterval(sseOwner.timer);
        sseOwner = undefined;
      }
    };
    const writeHeartbeat = (): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        release();
        return;
      }
      reply.raw.write('event: heartbeat\ndata: {}\n\n');
    };
    writeHeartbeat();
    const timer = setInterval(writeHeartbeat, heartbeatIntervalMs);
    sseOwner = { reply, timer };
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

  const assetRoot = options.assetRoot;
  if (assetRoot !== undefined) {
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

  await app.listen({ host: WEB_SERVER_HOST, port });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('The web server did not bind a TCP address.');
  }
  advertisedPort = address.port;
  if (address.address !== WEB_SERVER_HOST && address.address !== '127.0.0.1') {
    await app.close();
    throw new Error('The web server must listen on 127.0.0.1.');
  }

  const close = async (timeoutMs = WEB_SHUTDOWN_TIMEOUT_MS): Promise<void> => {
    serviceState = 'stopping';
    if (sseOwner !== undefined) {
      clearInterval(sseOwner.timer);
      sseOwner.reply.raw.end();
      sseOwner = undefined;
    }
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
    port: advertisedPort,
    bootstrapToken,
    bootstrapUrl: `${expectedOrigin(advertisedPort)}/#bootstrap=${bootstrapToken}`,
    app,
    close,
  };
}

export function defaultWebAssetRoot(distRoot: string): string {
  return path.join(distRoot, WEB_ASSET_SUBDIRECTORY);
}
