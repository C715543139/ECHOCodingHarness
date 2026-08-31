import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  WEB_BOUNDS,
  WEB_ERROR_CODES,
  isValidRequestId,
  type ExtensionMutationDto,
  type ExtensionSummaryDto,
} from '../../../src/contracts/web.js';
import {
  WEB_JSON_SCHEMAS,
  createApiResponseSchema,
  createPageSchema,
  validateWebJsonSchema,
} from '../../../src/contracts/web-schema.js';

const REQUEST_ID = 'req_0123456789abcd';

const BOUNDARY_SCHEMAS = [
  'apiErrorResponse',
  'workspaceSummary',
  'runtimeCapabilities',
  'sessionSummary',
  'approvalRequest',
  'sessionRuntime',
  'sessionView',
  'providerConfig',
  'bootstrap',
  'updateProviderConfigRequest',
  'discoverModelsRequest',
  'discoveredModels',
  'createSessionRequest',
  'chatTurn',
  'updateSessionRuntimeRequest',
  'submitTurnRequest',
  'acceptedTurn',
  'acceptedCancellation',
  'deletedSession',
  'approvalDecisionRequest',
  'acceptedApproval',
  'traceRecord',
  'traceRecordDetail',
  'extensionSummary',
  'extensionMutation',
  'extensionListResponse',
  'extensionMutationResponse',
  'projectionDelta',
  'webStreamEvent',
] as const;

function repeat(length: number): string {
  return 'x'.repeat(length);
}

function sessionSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'session-1',
    shortId: 'sess1',
    title: 'Investigate fixture',
    updatedAt: '2026-08-30T00:00:00.000Z',
    turnCount: 1,
    phase: 'idle',
    model: 'fake-model',
    safetyMode: 'balanced',
    ...overrides,
  };
}

function chatTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turnId: 'turn-1',
    startedAt: '2026-08-30T00:00:00.000Z',
    userText: 'hello',
    responses: [{ step: 1, text: 'ok', partial: false }],
    toolSummaries: [],
    status: 'completed',
    ...overrides,
  };
}

function traceRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rec-1',
    seq: 1,
    turnId: 'turn-1',
    time: '2026-08-30T00:00:00.000Z',
    type: 'user',
    label: 'User',
    status: 'recorded',
    hasDetails: false,
    ...overrides,
  };
}

describe('Web JSON Schema freeze', () => {
  it('publishes runtime schemas for every HTTP/SSE-boundary DTO', () => {
    for (const name of BOUNDARY_SCHEMAS) {
      expect(WEB_JSON_SCHEMAS[name], name).toBeDefined();
    }
    expect(WEB_JSON_SCHEMAS.webStreamEvent.oneOf).toHaveLength(4);
  });

  it('builds Page and ApiResponse schemas from one factory', () => {
    expect(WEB_JSON_SCHEMAS.pageSessionSummary).toEqual(
      createPageSchema(WEB_JSON_SCHEMAS.sessionSummary, WEB_BOUNDS.sessionPageMax),
    );
    expect(WEB_JSON_SCHEMAS.pageChatTurn).toEqual(
      createPageSchema(WEB_JSON_SCHEMAS.chatTurn, WEB_BOUNDS.chatPageMax),
    );
    expect(WEB_JSON_SCHEMAS.pageTraceRecord).toEqual(
      createPageSchema(WEB_JSON_SCHEMAS.traceRecord, WEB_BOUNDS.tracePageMax),
    );
    expect(WEB_JSON_SCHEMAS.sessionViewResponse).toEqual(
      createApiResponseSchema(WEB_JSON_SCHEMAS.sessionView),
    );
  });

  it('validates the bounded session deletion response', () => {
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.deletedSession, {
        sessionId: 'session-1',
        stoppedActiveTurn: true,
      }),
    ).toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.deletedSession, {
        sessionId: '../outside',
        stoppedActiveTurn: true,
      }),
    ).not.toEqual([]);
  });

  it('freezes strict bounded extension DTOs and response envelopes', () => {
    expectTypeOf<ExtensionSummaryDto>().toMatchTypeOf<{
      readonly id: string;
      readonly version: string;
      readonly contentHash: string;
      readonly state: 'enabled' | 'disabled' | 'quarantined';
      readonly tools: readonly string[];
      readonly loaded: boolean;
      readonly cleanupPending: boolean;
    }>();
    expectTypeOf<ExtensionMutationDto>().toMatchTypeOf<{
      readonly id: string;
      readonly state: 'enabled' | 'disabled' | 'quarantined' | 'absent';
      readonly loaded: boolean;
      readonly changed: boolean;
      readonly cleanupPending: boolean;
      readonly contentHash?: string;
      readonly deactivated?: boolean;
    }>();

    const summary = {
      id: 'pdf-reader',
      version: '1.2.3',
      contentHash: `sha256:${'a'.repeat(64)}`,
      state: 'enabled',
      tools: ['read_pdf'],
      loaded: true,
      cleanupPending: false,
    };
    const mutation = {
      id: 'pdf-reader',
      state: 'disabled',
      loaded: false,
      changed: true,
      cleanupPending: false,
      contentHash: `sha256:${'a'.repeat(64)}`,
      deactivated: true,
    };
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionSummary, summary)).toEqual([]);
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionMutation, mutation)).toEqual([]);
    const missingCleanup: Record<string, unknown> = { ...summary };
    Reflect.deleteProperty(missingCleanup, 'cleanupPending');
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionSummary, missingCleanup)).not.toEqual(
      [],
    );
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionListResponse, {
        data: [summary],
        requestId: REQUEST_ID,
      }),
    ).toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionMutationResponse, {
        data: mutation,
        requestId: REQUEST_ID,
      }),
    ).toEqual([]);

    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionSummary, {
        ...summary,
        sourcePath: 'C:\\Users\\private-user\\extension.mjs',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionSummary, {
        ...summary,
        tools: Array.from({ length: WEB_BOUNDS.extensionToolsMax + 1 }, () => 'read_pdf'),
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionSummary, {
        ...summary,
        quarantineReason: repeat(WEB_BOUNDS.extensionQuarantineReasonMax + 1),
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.extensionMutation, {
        ...mutation,
        state: 'removed',
      }),
    ).not.toEqual([]);
  });

  it('rejects invalid requestIds and accepts the documented opaque range', () => {
    expect(isValidRequestId('short')).toBe(false);
    expect(isValidRequestId('C:\\Users\\fixture\\id')).toBe(false);
    expect(isValidRequestId(REQUEST_ID)).toBe(true);
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.requestId, REQUEST_ID)).toEqual([]);
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.requestId, 'not-opaque/path')).not.toEqual([]);
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.requestId, repeat(15))).not.toEqual([]);
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.requestId, `r${repeat(128)}`)).not.toEqual([]);
  });

  it('rejects Windows and POSIX absolute paths as workspace display names', () => {
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.workspaceSummary, {
        name: 'C:\\Users\\name\\repo',
        fingerprint: 'fp_ok',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.workspaceSummary, {
        name: '/srv/echo-fixture/repo',
        fingerprint: 'fp_ok',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.workspaceSummary, {
        name: '.',
        fingerprint: 'fp_ok',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.workspaceSummary, {
        name: '..',
        fingerprint: 'fp_ok',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.workspaceSummary, {
        name: 'echo-fixture',
        fingerprint: 'fp_ok',
      }),
    ).toEqual([]);
  });

  it('rejects a two-million-character title and other oversize strings', () => {
    expect(
      validateWebJsonSchema(
        WEB_JSON_SCHEMAS.sessionSummary,
        sessionSummary({ title: repeat(2_000_000) }),
      ),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.submitTurnRequest, {
        text: repeat(WEB_BOUNDS.bodyMax + 1),
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(
        WEB_JSON_SCHEMAS.chatTurn,
        chatTurn({
          userText: repeat(WEB_BOUNDS.bodyMax + 1),
        }),
      ),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(
        WEB_JSON_SCHEMAS.traceRecord,
        traceRecord({ resultSummary: repeat(WEB_BOUNDS.textMax + 1) }),
      ),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.traceRecordDetail, {
        ...traceRecord({ hasDetails: true }),
        sections: [
          {
            key: 'evidence',
            title: 'Code',
            code: { language: 'ts', text: repeat(WEB_BOUNDS.bodyMax + 1), truncated: true },
          },
        ],
        relatedRecordIds: [],
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.traceRecordDetail, {
        ...traceRecord({ hasDetails: true }),
        sections: [
          {
            key: 'evidence',
            title: 'Diff',
            diff: { path: 'src/a.ts', text: repeat(WEB_BOUNDS.bodyMax + 1), truncated: true },
          },
        ],
        relatedRecordIds: [],
      }),
    ).not.toEqual([]);
  });

  it('rejects every documented oversize array', () => {
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.discoveredModels, {
        models: Array.from({ length: WEB_BOUNDS.modelsMax + 1 }, () => 'm'),
        fetchedAt: '2026-08-30T00:00:00.000Z',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.discoveredModels, {
        models: [repeat(WEB_BOUNDS.modelMax + 1)],
        fetchedAt: '2026-08-30T00:00:00.000Z',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(
        WEB_JSON_SCHEMAS.chatTurn,
        chatTurn({
          responses: Array.from({ length: WEB_BOUNDS.responsesMax + 1 }, (_, index) => ({
            step: index,
            text: 'ok',
            partial: false,
          })),
        }),
      ),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(
        WEB_JSON_SCHEMAS.chatTurn,
        chatTurn({
          toolSummaries: Array.from({ length: WEB_BOUNDS.toolSummariesMax + 1 }, (_, index) => ({
            toolCallId: `call-${String(index)}`,
            name: 'read_file',
            status: 'completed',
          })),
        }),
      ),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.projectionDelta, {
        view: {
          session: {
            ...sessionSummary(),
            context: { usedApproxTokens: 1, limitApproxTokens: 10 },
          },
          capabilities: {
            canCreateSession: true,
            canSubmitTurn: true,
            canChangeRuntime: true,
            canCancelTurn: false,
            canRespondToApproval: false,
          },
        },
        traceRecords: Array.from({ length: WEB_BOUNDS.traceRecordsMax + 1 }, (_, index) =>
          traceRecord({ id: `rec-${String(index)}`, seq: index }),
        ),
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.traceRecordDetail, {
        ...traceRecord({ hasDetails: true }),
        sections: Array.from({ length: WEB_BOUNDS.sectionsMax + 1 }, (_, index) => ({
          key: 'metadata',
          title: `Section ${String(index)}`,
        })),
        relatedRecordIds: [],
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.traceRecordDetail, {
        ...traceRecord({ hasDetails: true }),
        sections: [
          {
            key: 'metadata',
            title: 'Fields',
            fields: Array.from({ length: WEB_BOUNDS.fieldsMax + 1 }, (_, index) => ({
              label: `f${String(index)}`,
              value: 'v',
            })),
          },
        ],
        relatedRecordIds: [],
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.traceRecordDetail, {
        ...traceRecord({ hasDetails: true }),
        sections: [],
        relatedRecordIds: Array.from(
          { length: WEB_BOUNDS.relatedIdsMax + 1 },
          (_, index) => `id-${String(index)}`,
        ),
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.pageSessionSummary, {
        items: Array.from({ length: WEB_BOUNDS.sessionPageMax + 1 }, (_, index) =>
          sessionSummary({ id: `session-${String(index)}` }),
        ),
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.pageChatTurn, {
        items: Array.from({ length: WEB_BOUNDS.chatPageMax + 1 }, (_, index) =>
          chatTurn({ turnId: `turn-${String(index)}` }),
        ),
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.pageTraceRecord, {
        items: Array.from({ length: WEB_BOUNDS.tracePageMax + 1 }, (_, index) =>
          traceRecord({ id: `rec-${String(index)}`, seq: index }),
        ),
      }),
    ).not.toEqual([]);
  });

  it('rejects unknown fields on boundary DTOs', () => {
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.workspaceSummary, {
        name: 'echo-fixture',
        fingerprint: 'fp_ok',
        extra: true,
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.submitTurnRequest, { text: 'hello', unknown: 1 }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.acceptedTurn, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        acceptedAt: '2026-08-30T00:00:00.000Z',
        leaked: 'no',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.createSessionRequest, {
        model: 'fake',
        surprise: true,
      }),
    ).not.toEqual([]);
  });

  it('requires the exact bounded Full Access confirmation DTO', () => {
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.createSessionRequest, {
        safetyMode: 'full-access',
        fullAccessConfirmation: { acceptedRisk: true },
      }),
    ).toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.updateSessionRuntimeRequest, {
        safetyMode: 'full-access',
        fullAccessConfirmation: { acceptedRisk: true },
      }),
    ).toEqual([]);
    for (const confirmation of [
      undefined,
      { acceptedRisk: false },
      { acceptedRisk: true, source: 'model' },
      { acceptedRisk: true, extra: true },
    ]) {
      const payload = {
        safetyMode: 'full-access',
        ...(confirmation === undefined ? {} : { fullAccessConfirmation: confirmation }),
      };
      const schemaErrors = validateWebJsonSchema(WEB_JSON_SCHEMAS.createSessionRequest, payload);
      if (confirmation === undefined) {
        expect(schemaErrors).toEqual([]);
      } else {
        expect(schemaErrors).not.toEqual([]);
      }
    }
  });

  it('rejects API key, reasoning, and stack fields on DTOs', () => {
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.providerConfig, {
        baseUrl: 'https://provider.example/v1',
        catalog: { source: 'discover', cachedModels: ['fake-model'] },
        defaultModel: 'fake-model',
        apiKeyConfigured: true,
        writable: true,
        apiKey: 'sk-secret',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.updateProviderConfigRequest, {
        baseUrl: 'https://provider.example/v1',
        catalog: { source: 'discover' },
        defaultModel: 'fake-model',
        apiKey: 'sk-secret',
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.apiErrorResponse, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'failed',
          retryable: false,
          stack: 'Error: boom\n    at Object.<anonymous> (src/web.ts:1:1)',
        },
        requestId: REQUEST_ID,
      }),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.chatTurn, chatTurn({ reasoning: 'hidden chain' })),
    ).not.toEqual([]);
    expect(
      validateWebJsonSchema(
        WEB_JSON_SCHEMAS.traceRecord,
        traceRecord({ reasoning: 'hidden chain' }),
      ),
    ).not.toEqual([]);
  });

  it('freezes the documented error catalog including IDEMPOTENCY_CONFLICT', () => {
    expect(WEB_ERROR_CODES).toContain('IDEMPOTENCY_CONFLICT');
    expect(WEB_ERROR_CODES).toContain('TURN_ACTIVE');
    expect(WEB_ERROR_CODES).toContain('RESYNC_REQUIRED');
    expect(WEB_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'EXTENSION_NOT_FOUND',
        'EXTENSION_BUSY',
        'EXTENSION_INVALID',
        'EXTENSION_QUARANTINED',
        'EXTENSION_CLEANUP_PENDING',
      ]),
    );
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.apiErrorResponse, {
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The same request id was reused with a different payload.',
          retryable: false,
        },
        requestId: REQUEST_ID,
      }),
    ).toEqual([]);
    expect(
      validateWebJsonSchema(WEB_JSON_SCHEMAS.apiErrorResponse, {
        error: { code: 'NOT_A_CODE', message: 'nope', retryable: false },
        requestId: REQUEST_ID,
      }),
    ).not.toEqual([]);
  });
});
