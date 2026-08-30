import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ActiveTurnCoordinator } from '../../application/index.js';
import type { ProviderConfigService } from '../../config/index.js';
import {
  WEB_JSON_SCHEMAS,
  createApiResponseSchema,
  validateWebJsonSchema,
  type DiscoverModelsRequest,
  type UpdateProviderConfigRequest,
} from '../../contracts/index.js';
import { createIdempotencyStore, fingerprintIdempotencyRequest } from '../idempotency.js';
import type { WebServiceState } from '../runtime-capabilities.js';

import { requestIdOf, sendError, toProviderDto } from './http.js';

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

export interface ProviderApiDependencies {
  readonly configService: ProviderConfigService;
  readonly coordinator: ActiveTurnCoordinator;
  readonly state: { serviceState: WebServiceState };
}

const PROVIDER_RESPONSE_SCHEMA = createApiResponseSchema(WEB_JSON_SCHEMAS.providerConfig);
const DISCOVERED_RESPONSE_SCHEMA = createApiResponseSchema(WEB_JSON_SCHEMAS.discoveredModels);

function replyResult(reply: FastifyReply, result: HttpResult): HttpResult {
  void reply.status(result.status).header('Cache-Control', 'no-store').send(result.body);
  return result;
}

function errorResult(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: 'CONFIG_INVALID' | 'PROVIDER_UNAVAILABLE' | 'TURN_ACTIVE' | 'INTERNAL_ERROR',
  message: string,
  fields?: Readonly<Record<string, string>>,
): HttpResult {
  const body = sendError(reply, request, status, code, message, false, fields);
  return { status, body };
}

function issueFields(
  issues: readonly { readonly path?: string; readonly message: string }[],
): Readonly<Record<string, string>> | undefined {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    if (issue.path !== undefined && issue.path.length > 0) fields[issue.path] = issue.message;
  }
  return Object.keys(fields).length === 0 ? undefined : fields;
}

export function registerProviderApiRoutes(
  app: FastifyInstance,
  deps: ProviderApiDependencies,
): void {
  const store = createIdempotencyStore<HttpResult>();

  const writable = (): boolean =>
    deps.state.serviceState === 'running' && deps.coordinator.snapshot().sessionId === undefined;

  function envelope(
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    data: unknown,
    schema: Parameters<typeof validateWebJsonSchema>[0],
  ): HttpResult {
    const body = { data, requestId: requestIdOf(request) };
    if (validateWebJsonSchema(schema, body).length > 0) {
      return errorResult(
        reply,
        request,
        500,
        'INTERNAL_ERROR',
        'The response payload could not be built.',
      );
    }
    return replyResult(reply, { status, body });
  }

  async function withIdempotency(
    request: FastifyRequest,
    reply: FastifyReply,
    execute: () => Promise<HttpResult>,
  ): Promise<HttpResult> {
    const begun = store.begin(
      {
        method: request.method,
        route: request.routeOptions.url ?? request.url.split('?')[0] ?? '/',
        requestId: requestIdOf(request),
      },
      fingerprintIdempotencyRequest({ body: request.body ?? null, routeParams: {} }),
    );
    if (begun.kind === 'conflict') {
      const body = sendError(
        reply,
        request,
        409,
        'IDEMPOTENCY_CONFLICT',
        'The same request id was reused with a different payload.',
      );
      return { status: 409, body };
    }
    if (begun.kind === 'replay') return replyResult(reply, begun.response);
    if (begun.kind === 'inflight') return replyResult(reply, await begun.wait);
    try {
      const result = await execute();
      begun.commit(result);
      return result;
    } catch {
      const result = errorResult(
        reply,
        request,
        500,
        'INTERNAL_ERROR',
        'The request could not be completed.',
      );
      begun.commit(result);
      return result;
    }
  }

  app.get('/api/v1/provider', async (request, reply) => {
    const read = await deps.configService.read();
    if (!read.ok) {
      errorResult(
        reply,
        request,
        503,
        'PROVIDER_UNAVAILABLE',
        'Provider configuration is unavailable.',
      );
      return;
    }
    envelope(request, reply, 200, toProviderDto(read.value, writable()), PROVIDER_RESPONSE_SCHEMA);
  });

  app.put('/api/v1/provider', async (request, reply) => {
    await withIdempotency(request, reply, async () => {
      if (!writable()) {
        return errorResult(
          reply,
          request,
          409,
          'TURN_ACTIVE',
          'Provider settings are read-only while a turn is active.',
        );
      }
      if (
        validateWebJsonSchema(WEB_JSON_SCHEMAS.updateProviderConfigRequest, request.body).length > 0
      ) {
        return errorResult(reply, request, 400, 'CONFIG_INVALID', 'Provider settings are invalid.');
      }
      const saved = await deps.configService.saveProviderSettings(
        request.body as UpdateProviderConfigRequest,
      );
      if (!saved.ok) {
        return errorResult(
          reply,
          request,
          400,
          'CONFIG_INVALID',
          'Provider settings are invalid.',
          issueFields(saved.issues),
        );
      }
      return envelope(
        request,
        reply,
        200,
        toProviderDto(saved.value, writable()),
        PROVIDER_RESPONSE_SCHEMA,
      );
    });
  });

  app.post('/api/v1/provider/discover', async (request, reply) => {
    await withIdempotency(request, reply, async () => {
      if (!writable()) {
        return errorResult(
          reply,
          request,
          409,
          'TURN_ACTIVE',
          'Provider settings are read-only while a turn is active.',
        );
      }
      if (validateWebJsonSchema(WEB_JSON_SCHEMAS.discoverModelsRequest, request.body).length > 0) {
        return errorResult(
          reply,
          request,
          400,
          'CONFIG_INVALID',
          'The model discovery request is invalid.',
        );
      }
      const discovered = await deps.configService.discoverModels(
        (request.body as DiscoverModelsRequest).baseUrl,
      );
      if (!discovered.ok) {
        return errorResult(reply, request, 503, 'PROVIDER_UNAVAILABLE', discovered.error.message);
      }
      return envelope(request, reply, 200, discovered.value, DISCOVERED_RESPONSE_SCHEMA);
    });
  });
}
