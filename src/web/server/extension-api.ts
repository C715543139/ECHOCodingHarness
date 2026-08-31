import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  WEB_JSON_SCHEMAS,
  type ExtensionMutationDto,
  type ExtensionSummaryDto,
  type WebErrorCode,
} from '../../contracts/index.js';
import { validateWebJsonSchema } from '../../contracts/web-schema.js';
import { createIdempotencyStore, fingerprintIdempotencyRequest } from '../idempotency.js';
import { fieldText, type ProjectionRedaction } from '../trace/sanitize.js';

import { requestIdOf, sendError } from './http.js';

export type ExtensionAdministrationErrorCode = Extract<
  WebErrorCode,
  | 'EXTENSION_NOT_FOUND'
  | 'EXTENSION_BUSY'
  | 'EXTENSION_INVALID'
  | 'EXTENSION_QUARANTINED'
  | 'EXTENSION_CLEANUP_PENDING'
>;

export class ExtensionAdministrationError extends Error {
  readonly code: ExtensionAdministrationErrorCode;

  constructor(code: ExtensionAdministrationErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ExtensionAdministrationError';
    this.code = code;
  }
}

/**
 * Human administration boundary for one already-bound workspace.
 * P3-B2/C1 adapters own lifecycle state and return bounded DTO facts.
 */
export interface ExtensionAdministrationPort {
  list(): Promise<readonly ExtensionSummaryDto[]>;
  enable(extensionId: string): Promise<ExtensionMutationDto>;
  disable(extensionId: string): Promise<ExtensionMutationDto>;
  uninstall(extensionId: string): Promise<ExtensionMutationDto>;
}

export interface ExtensionApiDependencies {
  readonly administration?: ExtensionAdministrationPort;
  readonly redaction?: ProjectionRedaction;
}

interface ExtensionParams {
  readonly extensionId: string;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

const EMPTY_OBJECT_SCHEMA = { type: 'object', additionalProperties: false } as const;
const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const EXTENSION_ID_MAX = 64;

function replyResult(reply: FastifyReply, result: HttpResult): HttpResult {
  void reply.status(result.status).header('Cache-Control', 'no-store').send(result.body);
  return result;
}

function errorResult(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: WebErrorCode,
  message: string,
): HttpResult {
  const body = sendError(reply, request, status, code, message);
  return { status, body };
}

function mappedAdministrationError(error: unknown): {
  readonly status: number;
  readonly code: WebErrorCode;
  readonly message: string;
} {
  if (error instanceof ExtensionAdministrationError) {
    switch (error.code) {
      case 'EXTENSION_NOT_FOUND':
        return {
          status: 404,
          code: error.code,
          message: 'The requested extension was not found.',
        };
      case 'EXTENSION_BUSY':
        return {
          status: 409,
          code: error.code,
          message: 'The extension is busy. Stop the active turn and try again.',
        };
      case 'EXTENSION_QUARANTINED':
        return {
          status: 409,
          code: error.code,
          message: 'The extension is quarantined and could not be enabled.',
        };
      case 'EXTENSION_CLEANUP_PENDING':
        return {
          status: 409,
          code: error.code,
          message: 'The extension is deactivated but physical cleanup is still pending.',
        };
      case 'EXTENSION_INVALID':
        return {
          status: 409,
          code: error.code,
          message: 'The extension state is invalid and was not changed.',
        };
    }
  }
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'The extension request could not be completed.',
  };
}

function projectSummary(
  summary: ExtensionSummaryDto,
  redaction: ProjectionRedaction,
): ExtensionSummaryDto {
  return {
    id: summary.id,
    version: summary.version,
    contentHash: summary.contentHash,
    state: summary.state,
    tools: [...summary.tools],
    loaded: summary.loaded,
    ...(summary.quarantineReason === undefined
      ? {}
      : { quarantineReason: fieldText(summary.quarantineReason, 2_048, redaction) }),
    cleanupPending: summary.cleanupPending,
  };
}

function projectMutation(mutation: ExtensionMutationDto): ExtensionMutationDto {
  return {
    id: mutation.id,
    state: mutation.state,
    loaded: mutation.loaded,
    changed: mutation.changed,
    cleanupPending: mutation.cleanupPending,
    ...(mutation.contentHash === undefined ? {} : { contentHash: mutation.contentHash }),
    ...(mutation.deactivated === undefined ? {} : { deactivated: mutation.deactivated }),
  };
}

export function registerExtensionApiRoutes(
  app: FastifyInstance,
  deps: ExtensionApiDependencies,
): void {
  const store = createIdempotencyStore<HttpResult>();
  const redaction = deps.redaction ?? {};

  function envelope<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    data: T,
    schema: Parameters<typeof validateWebJsonSchema>[0],
  ): HttpResult {
    const body = { data, requestId: requestIdOf(request) };
    if (validateWebJsonSchema(schema, body).length > 0) {
      return errorResult(
        reply,
        request,
        500,
        'INTERNAL_ERROR',
        'The extension response payload could not be built.',
      );
    }
    return replyResult(reply, { status: 200, body });
  }

  function unavailable(reply: FastifyReply, request: FastifyRequest): HttpResult {
    return errorResult(
      reply,
      request,
      503,
      'EXTENSION_INVALID',
      'Extension administration is unavailable in this Web assembly.',
    );
  }

  function validId(reply: FastifyReply, request: FastifyRequest, extensionId: string): boolean {
    if (extensionId.length <= EXTENSION_ID_MAX && EXTENSION_ID_PATTERN.test(extensionId)) {
      return true;
    }
    errorResult(reply, request, 400, 'INVALID_REQUEST', 'The extension id is invalid.');
    return false;
  }

  async function withIdempotency(
    request: FastifyRequest,
    reply: FastifyReply,
    extensionId: string,
    execute: () => Promise<HttpResult>,
  ): Promise<HttpResult> {
    const begun = store.begin(
      {
        method: request.method,
        route: request.routeOptions.url ?? request.url.split('?')[0] ?? '/',
        requestId: requestIdOf(request),
      },
      fingerprintIdempotencyRequest({
        body: request.body ?? null,
        routeParams: { extensionId },
      }),
    );
    if (begun.kind === 'conflict') {
      return errorResult(
        reply,
        request,
        409,
        'IDEMPOTENCY_CONFLICT',
        'The same request id was reused with a different payload.',
      );
    }
    if (begun.kind === 'replay') return replyResult(reply, begun.response);
    if (begun.kind === 'inflight') return replyResult(reply, await begun.wait);
    try {
      const result = await execute();
      begun.commit(result);
      return result;
    } catch (error) {
      const mapped = mappedAdministrationError(error);
      const result = errorResult(reply, request, mapped.status, mapped.code, mapped.message);
      begun.commit(result);
      return result;
    }
  }

  app.get('/api/v1/extensions', async (request, reply) => {
    if (deps.administration === undefined) {
      unavailable(reply, request);
      return;
    }
    try {
      const listed = await deps.administration.list();
      envelope(
        request,
        reply,
        listed.map((summary) => projectSummary(summary, redaction)),
        WEB_JSON_SCHEMAS.extensionListResponse,
      );
    } catch (error) {
      const mapped = mappedAdministrationError(error);
      errorResult(reply, request, mapped.status, mapped.code, mapped.message);
    }
  });

  const registerMutation = (
    method: 'POST' | 'DELETE',
    route: string,
    execute: (
      port: ExtensionAdministrationPort,
      extensionId: string,
    ) => Promise<ExtensionMutationDto>,
  ): void => {
    app.route({
      method,
      url: route,
      handler: async (request, reply) => {
        const { extensionId } = request.params as ExtensionParams;
        if (!validId(reply, request, extensionId)) return;
        await withIdempotency(request, reply, extensionId, async () => {
          if (validateWebJsonSchema(EMPTY_OBJECT_SCHEMA, request.body ?? {}).length > 0) {
            return errorResult(
              reply,
              request,
              400,
              'INVALID_REQUEST',
              'The extension mutation request must be an empty object.',
            );
          }
          if (deps.administration === undefined) return unavailable(reply, request);
          const mutation = projectMutation(await execute(deps.administration, extensionId));
          return envelope(request, reply, mutation, WEB_JSON_SCHEMAS.extensionMutationResponse);
        });
      },
    });
  };

  registerMutation('POST', '/api/v1/extensions/:extensionId/enable', (port, id) => port.enable(id));
  registerMutation('POST', '/api/v1/extensions/:extensionId/disable', (port, id) =>
    port.disable(id),
  );
  registerMutation('DELETE', '/api/v1/extensions/:extensionId', (port, id) => port.uninstall(id));
}
