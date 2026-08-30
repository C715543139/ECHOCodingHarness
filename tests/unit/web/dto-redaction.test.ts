import { describe, expect, it } from 'vitest';

import type {
  AcceptedApprovalDto,
  AcceptedCancellationDto,
  AcceptedTurnDto,
  ApiErrorResponse,
  SessionViewDto,
} from '../../../src/contracts/web.js';
import { WEB_JSON_SCHEMAS, validateWebJsonSchema } from '../../../src/contracts/web-schema.js';
import { projectRuntimeCapabilities } from '../../../src/web/runtime-capabilities.js';

const REQUEST_ID = 'req_dto_0123456789ab';

const FORBIDDEN = [
  /ECHO_API_KEY/iu,
  /sk-[A-Za-z0-9]/u,
  /C:\\Users\\/iu,
  /\/home\//u,
  /model\.reasoning/iu,
  /at\s+\S+\s+\(/u,
];

function assertSanitized(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const pattern of FORBIDDEN) {
    expect(serialized).not.toMatch(pattern);
  }
}

describe('Web DTO redaction and write responses', () => {
  it('freezes SessionView and write-operation envelopes without secrets or paths', () => {
    const view: SessionViewDto = {
      session: {
        id: 'session-1',
        shortId: 'sess1',
        title: 'Investigate fixture',
        updatedAt: '2026-08-30T00:00:00.000Z',
        turnCount: 2,
        phase: 'idle',
        model: 'fake-model',
        safetyMode: 'balanced',
        context: { usedApproxTokens: 80, limitApproxTokens: 256000 },
      },
      capabilities: projectRuntimeCapabilities({
        serviceState: 'running',
        providerAvailable: true,
        selectedSessionAvailable: true,
        selectedSessionId: 'session-1',
        awaitingApproval: false,
      }),
    };
    const acceptedTurn: AcceptedTurnDto = {
      sessionId: 'session-1',
      turnId: 'turn-2',
      acceptedAt: '2026-08-30T00:00:01.000Z',
    };
    const acceptedCancel: AcceptedCancellationDto = {
      sessionId: 'session-1',
      turnId: 'turn-2',
      state: 'cancelling',
    };
    const acceptedApproval: AcceptedApprovalDto = {
      sessionId: 'session-1',
      turnId: 'turn-2',
      toolCallId: 'call-9',
      outcome: 'accepted',
    };
    const error: ApiErrorResponse = {
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The same request id was reused with a different payload.',
        retryable: false,
      },
      requestId: REQUEST_ID,
    };

    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.sessionView, view)).toEqual([]);
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.acceptedTurn, acceptedTurn)).toEqual([]);
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.acceptedCancellation, acceptedCancel)).toEqual(
      [],
    );
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.acceptedApproval, acceptedApproval)).toEqual([]);
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.apiErrorResponse, error)).toEqual([]);
    assertSanitized({ view, acceptedTurn, acceptedCancel, acceptedApproval, error });
  });

  it('rejects Provider DTOs that echo an API key or absolute path', () => {
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
      JSON.stringify({
        name: 'project',
        fingerprint: 'fp_ok',
      }),
    ).not.toMatch(/C:\\Users\\/u);
  });

  it('keeps API key, reasoning, and stack out of accepted DTO shapes', () => {
    expect(WEB_JSON_SCHEMAS.providerConfig.additionalProperties).toBe(false);
    expect(WEB_JSON_SCHEMAS.chatTurn.additionalProperties).toBe(false);
    expect(WEB_JSON_SCHEMAS.apiErrorResponse.additionalProperties).toBe(false);
    expect(JSON.stringify(WEB_JSON_SCHEMAS.providerConfig.properties)).not.toMatch(/apiKey[^C]/u);
    expect(JSON.stringify(WEB_JSON_SCHEMAS.chatTurn.properties)).not.toMatch(/reasoning/u);
    expect(JSON.stringify(WEB_JSON_SCHEMAS.apiErrorResponse.properties)).not.toMatch(/stack/u);
  });
});
