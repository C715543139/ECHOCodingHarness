import { randomBytes } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  isValidRequestId,
  type ApiErrorResponse,
  type ProviderConfigDto,
  type WebErrorCode,
} from '../../contracts/index.js';

export const WEB_SERVER_HOST = '127.0.0.1' as const;
export const WEB_ASSET_SUBDIRECTORY = 'web' as const;
export const WEB_AUTH_COOKIE = 'echo_web';
export const WEB_BODY_LIMIT_BYTES = 1_048_576;
export const WEB_SHUTDOWN_TIMEOUT_MS = 10_000;

export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const PATH_FIELD = /^(workspace|workspacePath|workspaceRoot|path|cwd)$/iu;

export function hexToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function expectedOrigin(port: number): string {
  return `http://${WEB_SERVER_HOST}:${String(port)}`;
}

export function expectedHost(port: number): string {
  return `${WEB_SERVER_HOST}:${String(port)}`;
}

export function headerValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

export function requestIdOf(request: FastifyRequest): string {
  const header = headerValue(request.headers['x-echo-request-id']);
  return isValidRequestId(header) ? header : `req_${hexToken(10)}`;
}

export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: WebErrorCode,
  message: string,
  retryable = false,
  fields?: Readonly<Record<string, string>>,
): ApiErrorResponse {
  const body: ApiErrorResponse = {
    error: {
      code,
      message,
      retryable,
      ...(fields === undefined || Object.keys(fields).length === 0 ? {} : { fields }),
    },
    requestId: requestIdOf(request),
  };
  void reply.status(status).header('Cache-Control', 'no-store').send(body);
  return body;
}

export function isMutating(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export function requestPath(url: string): string {
  return url.split('?')[0] ?? url;
}

export function isBootstrapPath(url: string): boolean {
  return requestPath(url) === '/api/v1/auth/bootstrap';
}

export function isApiPath(url: string): boolean {
  return requestPath(url).startsWith('/api/v1');
}

export function applySecurityHeaders(reply: FastifyReply, api: boolean): void {
  void reply.header('Content-Security-Policy', WEB_CSP);
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header('X-Frame-Options', 'DENY');
  if (api) void reply.header('Cache-Control', 'no-store');
}

export function hasForbiddenPathField(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenPathField(item));
  for (const [key, item] of Object.entries(value)) {
    if (PATH_FIELD.test(key)) return true;
    if (hasForbiddenPathField(item)) return true;
  }
  return false;
}

export function toProviderDto(
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
