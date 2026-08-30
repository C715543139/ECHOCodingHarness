import { describe, expect, it } from 'vitest';

import { WEB_JSON_SCHEMAS, validateWebJsonSchema } from '../../../src/contracts/web-schema.js';
import { projectRuntimeCapabilities } from '../../../src/web/runtime-capabilities.js';

describe('RuntimeCapabilities state table', () => {
  it('allows create/submit/runtime changes when idle and provider/session are available', () => {
    const capabilities = projectRuntimeCapabilities({
      serviceState: 'running',
      providerAvailable: true,
      selectedSessionAvailable: true,
      selectedSessionId: 'session-a',
      awaitingApproval: false,
    });

    expect(capabilities).toEqual({
      canCreateSession: true,
      canSubmitTurn: true,
      canChangeRuntime: true,
      canCancelTurn: false,
      canRespondToApproval: false,
    });
    expect(validateWebJsonSchema(WEB_JSON_SCHEMAS.runtimeCapabilities, capabilities)).toEqual([]);
  });

  it('keeps session creation open while the selected Session owns an active Turn', () => {
    const capabilities = projectRuntimeCapabilities({
      serviceState: 'running',
      providerAvailable: true,
      selectedSessionAvailable: true,
      selectedSessionId: 'session-a',
      activeSessionId: 'session-a',
      activeTurnId: 'turn-1',
      awaitingApproval: true,
    });

    expect(capabilities).toEqual({
      canCreateSession: true,
      canSubmitTurn: false,
      canChangeRuntime: false,
      canCancelTurn: true,
      canRespondToApproval: true,
      activeSessionId: 'session-a',
      activeTurnId: 'turn-1',
      submitTurnBlockedReason: 'turn_active',
      changeRuntimeBlockedReason: 'turn_active',
    });
  });

  it('blocks submit/runtime/cancel on a browsing Session while another Turn is active', () => {
    const capabilities = projectRuntimeCapabilities({
      serviceState: 'running',
      providerAvailable: true,
      selectedSessionAvailable: true,
      selectedSessionId: 'session-b',
      activeSessionId: 'session-a',
      activeTurnId: 'turn-1',
      awaitingApproval: true,
    });

    expect(capabilities).toEqual({
      canCreateSession: true,
      canSubmitTurn: false,
      canChangeRuntime: false,
      canCancelTurn: false,
      canRespondToApproval: false,
      activeSessionId: 'session-a',
      activeTurnId: 'turn-1',
      submitTurnBlockedReason: 'turn_active',
      changeRuntimeBlockedReason: 'turn_active',
    });
  });

  it('disables every mutating capability while the service is stopping', () => {
    const capabilities = projectRuntimeCapabilities({
      serviceState: 'stopping',
      providerAvailable: true,
      selectedSessionAvailable: true,
      selectedSessionId: 'session-a',
      activeSessionId: 'session-a',
      activeTurnId: 'turn-1',
      awaitingApproval: true,
    });

    expect(capabilities).toEqual({
      canCreateSession: false,
      canSubmitTurn: false,
      canChangeRuntime: false,
      canCancelTurn: false,
      canRespondToApproval: false,
      activeSessionId: 'session-a',
      activeTurnId: 'turn-1',
      createSessionBlockedReason: 'service_stopping',
      submitTurnBlockedReason: 'service_stopping',
      changeRuntimeBlockedReason: 'service_stopping',
    });
  });

  it('reports stable blocked reasons when Provider or Session is unavailable', () => {
    expect(
      projectRuntimeCapabilities({
        serviceState: 'running',
        providerAvailable: false,
        selectedSessionAvailable: true,
        selectedSessionId: 'session-a',
        awaitingApproval: false,
      }),
    ).toMatchObject({
      canCreateSession: true,
      canSubmitTurn: false,
      canChangeRuntime: false,
      submitTurnBlockedReason: 'provider_unavailable',
      changeRuntimeBlockedReason: 'provider_unavailable',
    });
    expect(
      projectRuntimeCapabilities({
        serviceState: 'running',
        providerAvailable: true,
        selectedSessionAvailable: false,
        selectedSessionId: 'session-missing',
        awaitingApproval: false,
      }),
    ).toMatchObject({
      canCreateSession: true,
      canSubmitTurn: false,
      canChangeRuntime: false,
      submitTurnBlockedReason: 'session_unavailable',
      changeRuntimeBlockedReason: 'session_unavailable',
    });
  });
});
