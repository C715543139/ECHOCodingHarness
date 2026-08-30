import type { FastifyInstance } from 'fastify';

import { isValidRequestId } from '../../contracts/index.js';
import type { WebServiceState } from '../runtime-capabilities.js';

import {
  WEB_AUTH_COOKIE,
  applySecurityHeaders,
  expectedHost,
  expectedOrigin,
  hasForbiddenPathField,
  headerValue,
  isApiPath,
  isBootstrapPath,
  isMutating,
  parseCookie,
  sendError,
} from './http.js';

export interface WebGuardState {
  advertisedPort: number;
  serviceState: WebServiceState;
  sessionSecret: string | undefined;
}

export function registerWebRequestGuards(app: FastifyInstance, state: WebGuardState): void {
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
}
