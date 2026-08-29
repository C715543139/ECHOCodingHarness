import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CLI_EXIT_CODES,
  CONFIG_ERROR_CODES,
  EVENT_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION_P0,
  P1_CONFIG_RELATIVE_PATH,
  P1_SETTING_SOURCES,
  P1_SLASH_COMMANDS,
  P1_TEST_MATRIX,
  exitCodeForAgentResult,
  type ApplicationService,
  type ApprovalResponseInput,
  type ApprovalResponseResult,
  type CreateSessionRecordInput,
  type EchoEventPayloads,
  type EchoEventType,
  type EndpointFingerprint,
  type ModelCatalogClient,
  type ModelCatalogSnapshot,
  type ProviderIdentity,
  type SessionRepository,
  type SessionSummary,
} from '../../../src/contracts/index.js';

describe('P1 frozen contracts', () => {
  it('keeps a unique test-matrix row with separate contract and runtime evidence', () => {
    const ids = P1_TEST_MATRIX.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(P1_TEST_MATRIX.some((row) => row.area === 'p0-guard')).toBe(true);
    expect(P1_CONFIG_RELATIVE_PATH.replaceAll('\\', '/')).toBe('.echo/config/echo.config.json');
    for (const row of P1_TEST_MATRIX) {
      expect(row.contractEvidence.length).toBeGreaterThan(0);
      expect(row.runtimeEvidence.length).toBeGreaterThan(0);
      expect(row.contractEvidence).not.toBe(row.runtimeEvidence);
      expect(Object.hasOwn(row, 'evidence')).toBe(false);
      expect(row.runtimeEvidence.includes('pending:')).toBe(false);
    }
  });

  it('keeps config merge as CLI over the artifact file, with setting sources separate', () => {
    expect(P1_SETTING_SOURCES).toEqual(['cli', 'session', 'config']);
    expect(CONFIG_ERROR_CODES.missingFile).toBe('CONFIG_MISSING');
    expect(CLI_EXIT_CODES.usageOrConfig).toBe(2);
  });

  it('freezes slash names and bracketed-paste delimiters without parsing input', () => {
    expect(P1_SLASH_COMMANDS).toEqual(['help', 'status', 'model', 'safety', 'quit']);
    expect(BRACKETED_PASTE_START.endsWith('200~')).toBe(true);
    expect(BRACKETED_PASTE_END.endsWith('201~')).toBe(true);
  });

  it('preserves P0 AgentResult exit codes and maps missing config to usageOrConfig', () => {
    const base = {
      sessionId: 's',
      turnId: 't',
      status: 'completed' as const,
      steps: 1,
      toolCalls: 0,
      stopReason: 'completed' as const,
    };
    expect(exitCodeForAgentResult(base)).toBe(CLI_EXIT_CODES.success);
    expect(exitCodeForAgentResult({ ...base, status: 'limited', stopReason: 'max_steps' })).toBe(6);
    expect(exitCodeForAgentResult({ ...base, status: 'cancelled', stopReason: 'cancelled' })).toBe(
      130,
    );
    expect(
      exitCodeForAgentResult({ ...base, status: 'failed', stopReason: 'provider_error' }),
    ).toBe(3);
    expect(exitCodeForAgentResult({ ...base, status: 'failed', stopReason: 'tool_error' })).toBe(4);
    expect(exitCodeForAgentResult({ ...base, status: 'failed', stopReason: 'policy_denied' })).toBe(
      5,
    );
    expect(exitCodeForAgentResult({ ...base, status: 'failed', stopReason: 'completed' })).toBe(1);
    expect(EVENT_SCHEMA_VERSION_P0).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(2);
  });

  it('brands endpoint fingerprints so raw URL strings cannot satisfy ProviderIdentity', () => {
    type StringIsFingerprint = string extends EndpointFingerprint ? true : false;
    expectTypeOf<StringIsFingerprint>().toEqualTypeOf<false>();
    expectTypeOf<ProviderIdentity['endpointFingerprint']>().toEqualTypeOf<EndpointFingerprint>();
    expectTypeOf<
      EchoEventPayloads['session.resumed']['provider']
    >().toEqualTypeOf<ProviderIdentity>();
    expectTypeOf<EchoEventPayloads['session.started']['provider']>().toEqualTypeOf<
      ProviderIdentity | undefined
    >();
    expectTypeOf<EchoEventPayloads['model.started']['provider']>().toEqualTypeOf<string>();
    expectTypeOf<EchoEventPayloads['model.started']['endpointFingerprint']>().toEqualTypeOf<
      EndpointFingerprint | undefined
    >();
  });

  it('keeps create/resume/approval contracts closed without implementing later runtimes', () => {
    expectTypeOf<CreateSessionRecordInput>().toHaveProperty('model');
    expectTypeOf<CreateSessionRecordInput>().toHaveProperty('safetyMode');
    expectTypeOf<CreateSessionRecordInput['model']>().toEqualTypeOf<SessionSummary['model']>();
    expectTypeOf<CreateSessionRecordInput['safetyMode']>().toEqualTypeOf<
      SessionSummary['safetyMode']
    >();
    expectTypeOf<ApprovalResponseInput>().toHaveProperty('turnId');
    expectTypeOf<ApprovalResponseInput>().toHaveProperty('approvalKey');
    expectTypeOf<ApprovalResponseInput>().toHaveProperty('toolCallId');
    expectTypeOf<ApplicationService['respondToApproval']>().returns.toEqualTypeOf<
      Promise<ApprovalResponseResult>
    >();
    expectTypeOf<ApplicationService['runTurn']>().toBeFunction();
    expectTypeOf<ApplicationService['resumeSession']>().toBeFunction();
    expectTypeOf<ApplicationService['getRuntimeState']>().toBeFunction();
    expectTypeOf<SessionRepository['create']>().toBeFunction();
    expectTypeOf<SessionRepository['resume']>().toBeFunction();
    expectTypeOf<SessionRepository['getQueryView']>().toBeFunction();
    expectTypeOf<ModelCatalogClient['listModelIds']>().toBeFunction();
    expectTypeOf<ModelCatalogSnapshot>().toHaveProperty('configuredModel');
    expectTypeOf<ModelCatalogSnapshot['source']>().toEqualTypeOf<'discover' | 'manual'>();
    type P1Events = Extract<EchoEventType, 'model.changed' | 'safety.changed' | 'session.resumed'>;
    expectTypeOf<P1Events>().toEqualTypeOf<
      'model.changed' | 'safety.changed' | 'session.resumed'
    >();
  });
});
