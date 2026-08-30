import type { RuntimeBlockReason, RuntimeCapabilitiesDto } from '../contracts/web.js';

export type WebServiceState = 'running' | 'stopping';

export interface RuntimeCapabilityInput {
  readonly serviceState: WebServiceState;
  readonly providerAvailable: boolean;
  readonly selectedSessionAvailable: boolean;
  readonly selectedSessionId?: string;
  readonly activeSessionId?: string;
  readonly activeTurnId?: string;
  readonly awaitingApproval: boolean;
}

function withActiveIds(
  capabilities: RuntimeCapabilitiesDto,
  input: RuntimeCapabilityInput,
): RuntimeCapabilitiesDto {
  return {
    ...capabilities,
    ...(input.activeSessionId === undefined ? {} : { activeSessionId: input.activeSessionId }),
    ...(input.activeTurnId === undefined ? {} : { activeTurnId: input.activeTurnId }),
  };
}

function blocked(
  reason: RuntimeBlockReason,
  fields: Readonly<
    Partial<
      Pick<
        RuntimeCapabilitiesDto,
        'createSessionBlockedReason' | 'submitTurnBlockedReason' | 'changeRuntimeBlockedReason'
      >
    >
  >,
): Pick<
  RuntimeCapabilitiesDto,
  'createSessionBlockedReason' | 'submitTurnBlockedReason' | 'changeRuntimeBlockedReason'
> {
  return {
    ...(fields.createSessionBlockedReason === undefined
      ? {}
      : { createSessionBlockedReason: reason }),
    ...(fields.submitTurnBlockedReason === undefined ? {} : { submitTurnBlockedReason: reason }),
    ...(fields.changeRuntimeBlockedReason === undefined
      ? {}
      : { changeRuntimeBlockedReason: reason }),
  };
}

export function projectRuntimeCapabilities(input: RuntimeCapabilityInput): RuntimeCapabilitiesDto {
  if (input.serviceState === 'stopping') {
    return withActiveIds(
      {
        canCreateSession: false,
        canSubmitTurn: false,
        canChangeRuntime: false,
        canCancelTurn: false,
        canRespondToApproval: false,
        ...blocked('service_stopping', {
          createSessionBlockedReason: 'service_stopping',
          submitTurnBlockedReason: 'service_stopping',
          changeRuntimeBlockedReason: 'service_stopping',
        }),
      },
      input,
    );
  }

  const hasActiveTurn = input.activeSessionId !== undefined && input.activeTurnId !== undefined;
  const activeOnSelected =
    hasActiveTurn &&
    input.selectedSessionId !== undefined &&
    input.activeSessionId === input.selectedSessionId;

  let canSubmitTurn = input.providerAvailable && input.selectedSessionAvailable && !hasActiveTurn;
  let canChangeRuntime = canSubmitTurn;
  const canCancelTurn = activeOnSelected;
  const canRespondToApproval = activeOnSelected && input.awaitingApproval;

  let submitTurnBlockedReason: RuntimeBlockReason | undefined;
  let changeRuntimeBlockedReason: RuntimeBlockReason | undefined;
  if (hasActiveTurn) {
    submitTurnBlockedReason = 'turn_active';
    changeRuntimeBlockedReason = 'turn_active';
  } else if (!input.providerAvailable) {
    submitTurnBlockedReason = 'provider_unavailable';
    changeRuntimeBlockedReason = 'provider_unavailable';
  } else if (!input.selectedSessionAvailable) {
    submitTurnBlockedReason = 'session_unavailable';
    changeRuntimeBlockedReason = 'session_unavailable';
  }

  if (!canSubmitTurn && submitTurnBlockedReason === undefined) {
    canSubmitTurn = false;
  }
  if (!canChangeRuntime && changeRuntimeBlockedReason === undefined) {
    canChangeRuntime = false;
  }

  return withActiveIds(
    {
      canCreateSession: true,
      canSubmitTurn,
      canChangeRuntime,
      canCancelTurn,
      canRespondToApproval,
      ...(submitTurnBlockedReason === undefined ? {} : { submitTurnBlockedReason }),
      ...(changeRuntimeBlockedReason === undefined ? {} : { changeRuntimeBlockedReason }),
    },
    input,
  );
}
