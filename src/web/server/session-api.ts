import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ActiveTurnCoordinator } from '../../application/active-turn-coordinator.js';
import type { ProviderConfigService } from '../../config/index.js';
import type {
  ApplicationService,
  ApprovalChoice,
  ApprovalChoiceDto,
  CreateSessionRequest,
  EchoEvent,
  EchoError,
  Page,
  ProviderIdentity,
  SafetyMode,
  SessionId,
  SessionQueryView,
  SubmitTurnRequest,
  TurnId,
  UpdateSessionRuntimeRequest,
  WebErrorCode,
  WebStreamEvent,
} from '../../contracts/index.js';
import {
  CONFIG_ERROR_CODES,
  WEB_BOUNDS,
  WEB_ID_PATTERN,
  WEB_JSON_SCHEMAS,
  createApiResponseSchema,
  isValidWorkspaceDisplayName,
  isWebStreamEvent,
  validateWebJsonSchema,
} from '../../contracts/index.js';
import { isConfigurationError, isStorageError } from '../../session/errors.js';
import { isSafeSessionId } from '../../session/jsonl-session-store.js';
import { toQueryView } from '../../session/session-query.js';
import { createIdempotencyStore, fingerprintIdempotencyRequest } from '../idempotency.js';
import type { WebServiceState } from '../runtime-capabilities.js';
import {
  currentChatTurn,
  historyGap,
  projectChatTurn,
  projectSessionSummary,
  projectSessionView,
  projectStreamEvent,
  type SessionProjectionContext,
} from '../session-projection.js';
import { formatSseEvent, type SessionEventHub } from '../sse-hub.js';

import { WEB_CSP, requestIdOf, sendError } from './http.js';

export interface SessionApiState {
  serviceState: WebServiceState;
}

export interface SessionApiDependencies {
  readonly application: ApplicationService;
  readonly coordinator: ActiveTurnCoordinator;
  readonly hub: SessionEventHub;
  readonly configService: ProviderConfigService;
  readonly providerIdentity: ProviderIdentity;
  readonly workspaceRoot: string;
  readonly state: SessionApiState;
  readonly heartbeatIntervalMs: number;
  readonly secrets?: readonly string[];
  readonly homeDirectory?: string;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

interface SessionParams {
  readonly sessionId: string;
}

interface TurnParams extends SessionParams {
  readonly turnId: string;
}

interface ApprovalParams extends SessionParams {
  readonly approvalKey: string;
}

const SESSION_PAGE_DEFAULT = 30;
const CHAT_PAGE_DEFAULT = 30;
const EMPTY_OBJECT_SCHEMA = { type: 'object', additionalProperties: false } as const;

const APPROVAL_CHOICES: Record<ApprovalChoiceDto, ApprovalChoice> = {
  deny: 'deny',
  allow_once: 'once',
  allow_session: 'session',
};

const PAGE_SESSION_SCHEMA = createApiResponseSchema(WEB_JSON_SCHEMAS.pageSessionSummary);
const PAGE_CHAT_SCHEMA = createApiResponseSchema(WEB_JSON_SCHEMAS.pageChatTurn);
const SESSION_VIEW_RESPONSE_SCHEMA = WEB_JSON_SCHEMAS.sessionViewResponse;
const ACCEPTED_TURN_SCHEMA = createApiResponseSchema(WEB_JSON_SCHEMAS.acceptedTurn);
const ACCEPTED_CANCEL_SCHEMA = createApiResponseSchema(WEB_JSON_SCHEMAS.acceptedCancellation);
const ACCEPTED_APPROVAL_SCHEMA = createApiResponseSchema(WEB_JSON_SCHEMAS.acceptedApproval);

function workspaceName(workspaceRoot: string): string {
  const raw =
    workspaceRoot
      .split(/[/\\]/u)
      .filter((part) => part.length > 0)
      .at(-1) ?? 'workspace';
  return isValidWorkspaceDisplayName(raw) ? raw : 'workspace';
}

function isEchoError(error: unknown): error is EchoError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'category' in error &&
    'code' in error &&
    typeof (error as EchoError).code === 'string'
  );
}

function mappedError(error: unknown): {
  readonly status: number;
  readonly code: WebErrorCode;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (isConfigurationError(error) || isStorageError(error) || isEchoError(error)) {
    switch (error.code) {
      case CONFIG_ERROR_CODES.sessionNotFound:
        return {
          status: 404,
          code: 'NOT_FOUND',
          message: 'The requested session was not found.',
          retryable: false,
        };
      case CONFIG_ERROR_CODES.sessionWorkspaceMismatch:
        return {
          status: 400,
          code: 'WORKSPACE_MISMATCH',
          message: 'The session does not belong to this workspace.',
          retryable: false,
        };
      case CONFIG_ERROR_CODES.providerMismatch:
      case CONFIG_ERROR_CODES.sessionIncompatible:
      case CONFIG_ERROR_CODES.sessionCorrupt:
      case 'SESSION_LOG_INCOMPATIBLE':
      case 'SESSION_LOG_INVALID':
        return {
          status: 409,
          code: 'SESSION_INCOMPATIBLE',
          message: 'The session cannot be restored in this workspace.',
          retryable: false,
        };
      default:
        if (error.category.startsWith('provider_')) {
          return {
            status: 503,
            code: 'PROVIDER_UNAVAILABLE',
            message: 'The model provider is unavailable.',
            retryable: error.retryable,
          };
        }
    }
  }
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'The request could not be completed.',
    retryable: false,
  };
}

function parseLimit(raw: unknown, fallback: number, max: number): number | undefined {
  if (raw === undefined) return fallback;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== 'string' && typeof text !== 'number') return undefined;
  const value = typeof text === 'number' ? text : Number.parseInt(text, 10);
  if (!Number.isInteger(value) || value < 1 || value > max) return undefined;
  return value;
}

function parseCursor(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== 'string' || !WEB_ID_PATTERN.test(text)) return undefined;
  return text;
}

function parseAfter(raw: unknown, lastEventId: string): number | undefined {
  const candidate = raw === undefined || raw === '' ? lastEventId : raw;
  const text = Array.isArray(candidate) ? candidate[0] : candidate;
  if (text === undefined || text === '') return 0;
  if (typeof text !== 'string' && typeof text !== 'number') return undefined;
  const value = typeof text === 'number' ? text : Number.parseInt(text, 10);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function mergeEvents(base: readonly EchoEvent[], extra: readonly EchoEvent[]): EchoEvent[] {
  const bySeq = new Map<number, EchoEvent>();
  for (const event of base) bySeq.set(event.sequence, event);
  for (const event of extra) {
    if (!bySeq.has(event.sequence)) bySeq.set(event.sequence, event);
  }
  return [...bySeq.values()].toSorted((left, right) => left.sequence - right.sequence);
}

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
  retryable = false,
  fields?: Readonly<Record<string, string>>,
): HttpResult {
  const body = sendError(reply, request, status, code, message, retryable, fields);
  return { status, body };
}

export function registerSessionApiRoutes(app: FastifyInstance, deps: SessionApiDependencies): void {
  const store = createIdempotencyStore<HttpResult>();
  const name = workspaceName(deps.workspaceRoot);
  const redaction = {
    ...(deps.secrets === undefined ? {} : { secrets: deps.secrets }),
    workspaceRoot: deps.workspaceRoot,
    ...(deps.homeDirectory === undefined ? {} : { homeDirectory: deps.homeDirectory }),
  };

  function projectionContext(): SessionProjectionContext {
    const active = deps.coordinator.snapshot();
    return {
      capabilities: {
        serviceState: deps.state.serviceState,
        providerAvailable: true,
        selectedSessionAvailable: false,
        awaitingApproval: false,
        ...(active.sessionId === undefined ? {} : { activeSessionId: active.sessionId }),
        ...(active.turnId === undefined ? {} : { activeTurnId: active.turnId }),
      },
      redaction,
      ...(active.sessionId === undefined ? {} : { activeSessionId: active.sessionId }),
      ...(active.turnId === undefined ? {} : { activeTurnId: active.turnId }),
    };
  }

  async function providerAvailable(): Promise<boolean> {
    const read = await deps.configService.read();
    return read.ok && read.value.apiKeyConfigured;
  }

  async function contextFor(view: SessionQueryView): Promise<SessionProjectionContext> {
    const base = projectionContext();
    return {
      ...base,
      capabilities: {
        ...base.capabilities,
        providerAvailable: await providerAvailable(),
        selectedSessionAvailable: true,
        selectedSessionId: view.sessionId,
        awaitingApproval: false,
      },
    };
  }

  async function loadView(sessionId: SessionId): Promise<SessionQueryView> {
    return deps.application.getSession(sessionId);
  }

  function validateSessionId(
    reply: FastifyReply,
    request: FastifyRequest,
    sessionId: string,
  ): sessionId is SessionId {
    if (isSafeSessionId(sessionId) && WEB_ID_PATTERN.test(sessionId)) return true;
    errorResult(reply, request, 400, 'INVALID_REQUEST', 'The session id is invalid.');
    return false;
  }

  async function withIdempotency(
    request: FastifyRequest,
    reply: FastifyReply,
    routeParams: Readonly<Record<string, string>>,
    execute: () => Promise<HttpResult>,
  ): Promise<HttpResult> {
    const fingerprint = fingerprintIdempotencyRequest({
      body: request.body ?? null,
      routeParams,
    });
    const begun = store.begin(
      {
        method: request.method,
        route: request.routeOptions.url ?? request.url.split('?')[0] ?? '/',
        requestId: requestIdOf(request),
      },
      fingerprint,
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
    if (begun.kind === 'replay') {
      return replyResult(reply, begun.response);
    }
    if (begun.kind === 'inflight') {
      return replyResult(reply, await begun.wait);
    }
    try {
      const result = await execute();
      begun.commit(result);
      return result;
    } catch (error) {
      const mapped = mappedError(error);
      const result = errorResult(
        reply,
        request,
        mapped.status,
        mapped.code,
        mapped.message,
        mapped.retryable,
      );
      begun.commit(result);
      return result;
    }
  }

  function envelope<T>(
    request: FastifyRequest,
    data: T,
    schema: Parameters<typeof validateWebJsonSchema>[0],
    status: number,
    reply: FastifyReply,
  ): HttpResult {
    const body = { data, requestId: requestIdOf(request) };
    const schemaErrors = validateWebJsonSchema(schema, body);
    if (schemaErrors.length > 0) {
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

  app.get('/api/v1/sessions', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const limit = parseLimit(query['limit'], SESSION_PAGE_DEFAULT, WEB_BOUNDS.sessionPageMax);
    const cursorRaw = query['cursor'];
    const cursor = cursorRaw === undefined ? undefined : parseCursor(cursorRaw);
    if (limit === undefined || (cursorRaw !== undefined && cursor === undefined)) {
      errorResult(reply, request, 400, 'INVALID_REQUEST', 'The session page request is invalid.');
      return;
    }
    try {
      const listed = await deps.application.listSessions(deps.workspaceRoot);
      const sorted = [...listed].toSorted((left, right) => {
        const byTime = right.updatedAt.localeCompare(left.updatedAt);
        return byTime !== 0 ? byTime : right.sessionId.localeCompare(left.sessionId);
      });
      let start = 0;
      if (cursor !== undefined) {
        const index = sorted.findIndex((item) => item.sessionId === cursor);
        if (index < 0) {
          errorResult(
            reply,
            request,
            400,
            'INVALID_REQUEST',
            'The session page request is invalid.',
          );
          return;
        }
        start = index + 1;
      }
      const slice = sorted.slice(start, start + limit);
      const items = [];
      for (const summary of slice) {
        const view = await loadView(summary.sessionId);
        items.push(projectSessionSummary(view, await contextFor(view)));
      }
      const last = items.at(-1);
      const page: Page<(typeof items)[number]> = {
        items,
        ...(start + slice.length < sorted.length && last !== undefined
          ? { nextCursor: last.id }
          : {}),
      };
      envelope(request, page, PAGE_SESSION_SCHEMA, 200, reply);
    } catch (error) {
      const mapped = mappedError(error);
      errorResult(reply, request, mapped.status, mapped.code, mapped.message, mapped.retryable);
    }
  });

  app.post('/api/v1/sessions', async (request, reply) => {
    await withIdempotency(request, reply, {}, async () => {
      const errors = validateWebJsonSchema(WEB_JSON_SCHEMAS.createSessionRequest, request.body);
      if (errors.length > 0) {
        return errorResult(
          reply,
          request,
          400,
          'INVALID_REQUEST',
          'The session request is invalid.',
        );
      }
      const body = (request.body ?? {}) as CreateSessionRequest;
      const read = await deps.configService.read();
      if (!read.ok) {
        return errorResult(
          reply,
          request,
          503,
          'PROVIDER_UNAVAILABLE',
          'Provider configuration is unavailable.',
        );
      }
      const runtime = await deps.application.createSession({
        workspaceRoot: deps.workspaceRoot,
        provider: deps.providerIdentity,
        model: {
          value: body.model ?? read.value.persistent.model,
          source: body.model === undefined ? 'config' : 'session',
        },
        safetyMode: {
          value: body.safetyMode ?? read.value.persistent.safetyMode,
          source: body.safetyMode === undefined ? 'config' : 'session',
        },
      });
      const view = await loadView(runtime.sessionId);
      return envelope(
        request,
        projectSessionView(view, await contextFor(view)),
        SESSION_VIEW_RESPONSE_SCHEMA,
        201,
        reply,
      );
    });
  });

  app.get('/api/v1/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as SessionParams;
    if (!validateSessionId(reply, request, sessionId)) return;
    try {
      const view = await loadView(sessionId);
      envelope(
        request,
        projectSessionView(view, await contextFor(view)),
        SESSION_VIEW_RESPONSE_SCHEMA,
        200,
        reply,
      );
    } catch (error) {
      const mapped = mappedError(error);
      errorResult(reply, request, mapped.status, mapped.code, mapped.message, mapped.retryable);
    }
  });

  app.get('/api/v1/sessions/:sessionId/chat', async (request, reply) => {
    const { sessionId } = request.params as SessionParams;
    if (!validateSessionId(reply, request, sessionId)) return;
    const query = request.query as Record<string, unknown>;
    const limit = parseLimit(query['limit'], CHAT_PAGE_DEFAULT, WEB_BOUNDS.chatPageMax);
    const cursorRaw = query['cursor'];
    const cursor = cursorRaw === undefined ? undefined : parseCursor(cursorRaw);
    if (limit === undefined || (cursorRaw !== undefined && cursor === undefined)) {
      errorResult(reply, request, 400, 'INVALID_REQUEST', 'The chat page request is invalid.');
      return;
    }
    try {
      const view = await loadView(sessionId);
      const context = await contextFor(view);
      let turns = [...view.turns];
      if (cursor !== undefined) {
        const index = turns.findIndex((turn) => turn.turnId === cursor);
        if (index < 0) {
          errorResult(reply, request, 400, 'INVALID_REQUEST', 'The chat page request is invalid.');
          return;
        }
        turns = turns.slice(0, index);
      }
      const older = turns.length > limit;
      const window = older ? turns.slice(turns.length - limit) : turns;
      const page: Page<ReturnType<typeof projectChatTurn>> = {
        items: window.map((turn) => projectChatTurn(turn, context.redaction)),
        ...(older && window[0] !== undefined ? { nextCursor: window[0].turnId } : {}),
      };
      envelope(request, page, PAGE_CHAT_SCHEMA, 200, reply);
    } catch (error) {
      const mapped = mappedError(error);
      errorResult(reply, request, mapped.status, mapped.code, mapped.message, mapped.retryable);
    }
  });

  app.patch('/api/v1/sessions/:sessionId/runtime', async (request, reply) => {
    const { sessionId } = request.params as SessionParams;
    if (!validateSessionId(reply, request, sessionId)) return;
    await withIdempotency(request, reply, { sessionId }, async () => {
      const errors = validateWebJsonSchema(
        WEB_JSON_SCHEMAS.updateSessionRuntimeRequest,
        request.body,
      );
      const body = (request.body ?? {}) as UpdateSessionRuntimeRequest;
      if (errors.length > 0 || (body.model === undefined && body.safetyMode === undefined)) {
        return errorResult(
          reply,
          request,
          400,
          'INVALID_REQUEST',
          'The runtime update must include a model or safety mode.',
        );
      }
      const active = deps.coordinator.snapshot();
      if (active.sessionId !== undefined && active.turnId !== undefined) {
        return errorResult(
          reply,
          request,
          409,
          'TURN_ACTIVE',
          'A turn is already running.',
          false,
          { activeSessionId: active.sessionId, activeTurnId: active.turnId },
        );
      }
      if (body.model !== undefined) {
        await deps.application.setSessionModel(sessionId, body.model);
      }
      if (body.safetyMode !== undefined) {
        await deps.application.setSessionSafetyMode(sessionId, body.safetyMode as SafetyMode);
      }
      const view = await loadView(sessionId);
      return envelope(
        request,
        projectSessionView(view, await contextFor(view)),
        SESSION_VIEW_RESPONSE_SCHEMA,
        200,
        reply,
      );
    });
  });

  app.post('/api/v1/sessions/:sessionId/turns', async (request, reply) => {
    const { sessionId } = request.params as SessionParams;
    if (!validateSessionId(reply, request, sessionId)) return;
    await withIdempotency(request, reply, { sessionId }, async () => {
      const errors = validateWebJsonSchema(WEB_JSON_SCHEMAS.submitTurnRequest, request.body);
      const body = (request.body ?? {}) as SubmitTurnRequest;
      if (errors.length > 0 || body.text === undefined || body.text.trim().length === 0) {
        return errorResult(reply, request, 400, 'INVALID_REQUEST', 'The turn text is invalid.');
      }
      const submitted = await deps.coordinator.submitTurn(sessionId, body.text.trim());
      if (submitted.kind === 'turn_active') {
        return errorResult(
          reply,
          request,
          409,
          'TURN_ACTIVE',
          'A turn is already running.',
          false,
          {
            activeSessionId: submitted.activeSessionId,
            activeTurnId: submitted.activeTurnId,
          },
        );
      }
      return envelope(
        request,
        {
          sessionId: submitted.sessionId,
          turnId: submitted.turnId,
          acceptedAt: submitted.acceptedAt,
        },
        ACCEPTED_TURN_SCHEMA,
        202,
        reply,
      );
    });
  });

  app.post('/api/v1/sessions/:sessionId/turns/:turnId/cancel', async (request, reply) => {
    const { sessionId, turnId } = request.params as TurnParams;
    if (!validateSessionId(reply, request, sessionId)) return;
    if (!WEB_ID_PATTERN.test(turnId)) {
      errorResult(reply, request, 400, 'INVALID_REQUEST', 'The turn id is invalid.');
      return;
    }
    await withIdempotency(request, reply, { sessionId, turnId }, async () => {
      const errors = validateWebJsonSchema(EMPTY_OBJECT_SCHEMA, request.body ?? {});
      if (errors.length > 0) {
        return errorResult(
          reply,
          request,
          400,
          'INVALID_REQUEST',
          'The cancel request is invalid.',
        );
      }
      const cancelled = await deps.coordinator.cancelTurn(sessionId, turnId as TurnId);
      if (cancelled.kind === 'not_active') {
        return errorResult(reply, request, 409, 'TURN_NOT_ACTIVE', 'The turn is not active.');
      }
      return envelope(
        request,
        { sessionId, turnId, state: 'cancelling' as const },
        ACCEPTED_CANCEL_SCHEMA,
        202,
        reply,
      );
    });
  });

  app.post('/api/v1/sessions/:sessionId/approvals/:approvalKey', async (request, reply) => {
    const { sessionId, approvalKey } = request.params as ApprovalParams;
    if (!validateSessionId(reply, request, sessionId)) return;
    await withIdempotency(request, reply, { sessionId, approvalKey }, async () => {
      const errors = validateWebJsonSchema(WEB_JSON_SCHEMAS.approvalDecisionRequest, request.body);
      if (errors.length > 0) {
        return errorResult(
          reply,
          request,
          400,
          'INVALID_REQUEST',
          'The approval request is invalid.',
        );
      }
      const body = request.body as {
        readonly turnId: string;
        readonly toolCallId: string;
        readonly decision: ApprovalChoiceDto;
      };
      const result = await deps.application.respondToApproval({
        sessionId,
        turnId: body.turnId,
        toolCallId: body.toolCallId,
        approvalKey,
        choice: APPROVAL_CHOICES[body.decision],
      });
      if (result.outcome === 'accepted') {
        return envelope(
          request,
          {
            sessionId,
            turnId: body.turnId,
            toolCallId: body.toolCallId,
            outcome: 'accepted' as const,
          },
          ACCEPTED_APPROVAL_SCHEMA,
          202,
          reply,
        );
      }
      const code =
        result.reason === 'duplicate'
          ? 'APPROVAL_DUPLICATE'
          : result.reason === 'expired'
            ? 'APPROVAL_EXPIRED'
            : 'APPROVAL_NOT_PENDING';
      return errorResult(reply, request, 409, code, 'The approval could not be applied.');
    });
  });

  app.get('/api/v1/sessions/:sessionId/events', async (request, reply) => {
    const { sessionId } = request.params as SessionParams;
    if (!validateSessionId(reply, request, sessionId)) return;
    if (deps.state.serviceState === 'stopping') {
      errorResult(reply, request, 400, 'INVALID_REQUEST', 'The service is stopping.');
      return;
    }
    const query = request.query as Record<string, unknown>;
    const lastEventId = String(request.headers['last-event-id'] ?? '');
    const after = parseAfter(query['after'], lastEventId);
    if (after === undefined) {
      errorResult(reply, request, 400, 'INVALID_REQUEST', 'The stream resume cursor is invalid.');
      return;
    }
    const active = deps.coordinator.snapshot();
    if (
      active.sessionId !== undefined &&
      active.turnId !== undefined &&
      active.sessionId !== sessionId
    ) {
      errorResult(
        reply,
        request,
        409,
        'TURN_ACTIVE',
        'The live stream is bound to the active turn session.',
        false,
        { activeSessionId: active.sessionId, activeTurnId: active.turnId },
      );
      return;
    }
    const lease = deps.hub.claimStream(sessionId);
    if (lease === undefined) {
      errorResult(
        reply,
        request,
        409,
        'STREAM_ACTIVE',
        'This authentication cookie already has an active stream.',
      );
      return;
    }
    const socket = request.raw.socket;
    const abortBeforeHijack = (): void => {
      lease.release();
    };
    if (socket === null || socket.destroyed || request.raw.destroyed) {
      lease.release();
      return;
    }
    socket.once('close', abortBeforeHijack);
    request.raw.once('aborted', abortBeforeHijack);

    let view: SessionQueryView;
    let context: Awaited<ReturnType<typeof contextFor>>;
    try {
      view = await loadView(sessionId);
      context = await contextFor(view);
    } catch (error) {
      socket.off('close', abortBeforeHijack);
      request.raw.off('aborted', abortBeforeHijack);
      if (!lease.released) lease.release();
      const mapped = mappedError(error);
      errorResult(reply, request, mapped.status, mapped.code, mapped.message, mapped.retryable);
      return;
    }
    socket.off('close', abortBeforeHijack);
    request.raw.off('aborted', abortBeforeHijack);
    if (lease.released || request.raw.destroyed || socket.destroyed) {
      if (!lease.released) lease.release();
      return;
    }

    void reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Security-Policy': WEB_CSP,
      'X-Content-Type-Options': 'nosniff',
    });

    let released = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastSentSeq = after;
    let known = [...view.events];

    const release = (): void => {
      lease.release();
    };
    lease.setOnRelease(() => {
      if (released) return;
      released = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    });

    const write = (chunk: string): boolean => {
      if (released || reply.raw.destroyed || reply.raw.writableEnded) {
        release();
        return false;
      }
      try {
        // `write()` returning false is backpressure, not a stream failure.
        reply.raw.write(chunk);
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          release();
          return false;
        }
        return true;
      } catch {
        release();
        return false;
      }
    };

    const sendBusiness = (event: WebStreamEvent): boolean => {
      if (event.type === 'resync.required') {
        write(formatSseEvent({ event: event.type, data: JSON.stringify(event) }));
        release();
        return false;
      }
      if (!isWebStreamEvent(event)) {
        return sendBusiness({
          type: 'resync.required',
          sessionId,
          lastAvailableSeq: lastSentSeq,
          reason: 'projection_version_changed',
        });
      }
      if (event.seq <= lastSentSeq) return true;
      lastSentSeq = event.seq;
      return write(
        formatSseEvent({
          id: String(event.seq),
          event: event.type,
          data: JSON.stringify(event),
        }),
      );
    };

    const emitEcho = (event: EchoEvent): void => {
      if (released) return;
      if (event.sequence <= lastSentSeq) return;
      if (lastSentSeq > 0 && event.sequence !== lastSentSeq + 1) {
        sendBusiness({
          type: 'resync.required',
          sessionId,
          lastAvailableSeq: event.sequence,
          reason: 'history_gap',
        });
        return;
      }
      known = mergeEvents(known, [event]);
      const prefix = known.filter((item) => item.sequence <= event.sequence);
      const prefixView = toQueryView(sessionId, name, prefix);
      sendBusiness(
        projectStreamEvent(
          event,
          projectSessionView(prefixView, context),
          currentChatTurn(prefixView, context.redaction),
        ),
      );
    };

    try {
      if (historyGap(view.events, after)) {
        sendBusiness({
          type: 'resync.required',
          sessionId,
          lastAvailableSeq: view.events.at(-1)?.sequence ?? 0,
          reason: 'history_gap',
        });
        return;
      }

      for (const event of view.events) {
        if (event.sequence <= after) continue;
        emitEcho(event);
        if (released) return;
      }

      lease.handover(emitEcho);
      if (released) return;

      if (!write(formatSseEvent({ event: 'heartbeat', data: '{}' }))) return;
      timer = setInterval(() => {
        write(formatSseEvent({ event: 'heartbeat', data: '{}' }));
      }, deps.heartbeatIntervalMs);
      request.raw.once('close', release);
      request.raw.once('aborted', release);
      request.raw.socket?.once('close', release);
      reply.raw.once('close', release);
      reply.raw.once('finish', release);
      reply.raw.once('error', release);
    } catch {
      sendBusiness({
        type: 'resync.required',
        sessionId,
        lastAvailableSeq: lastSentSeq,
        reason: 'projection_version_changed',
      });
    }
  });
}
