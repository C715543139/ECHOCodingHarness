import {
  WEB_BOUNDS,
  WEB_ERROR_CODES,
  WEB_STREAM_EVENT_TYPES,
  type ApiErrorResponse,
  type WebStreamEvent,
} from './web.js';

export type JsonSchema = Readonly<Record<string, unknown>>;

const B = WEB_BOUNDS;

const REQUEST_ID_SCHEMA = {
  type: 'string',
  minLength: B.requestIdMin,
  maxLength: B.requestIdMax,
  pattern: '^[A-Za-z0-9._~-]{16,128}$',
} as const;

const ID_SCHEMA = {
  type: 'string',
  minLength: B.idMin,
  maxLength: B.idMax,
  pattern: '^[A-Za-z0-9._~-]{1,128}$',
} as const;

const WORKSPACE_NAME_SCHEMA = {
  type: 'string',
  minLength: B.workspaceNameMin,
  maxLength: B.workspaceNameMax,
  pattern: '^(?!\\.$)(?!\\.\\.$)[^/\\\\:\\u0000-\\u001F]{1,255}$',
} as const;

const TITLE_SCHEMA = { type: 'string', minLength: 1, maxLength: B.titleMax } as const;
const MODEL_SCHEMA = { type: 'string', minLength: 1, maxLength: B.modelMax } as const;
const TOOL_SCHEMA = { type: 'string', minLength: 1, maxLength: B.toolMax } as const;
const BASE_URL_SCHEMA = { type: 'string', minLength: 1, maxLength: B.baseUrlMax } as const;
const LABEL_SCHEMA = { type: 'string', minLength: 1, maxLength: B.labelMax } as const;
const STATUS_SCHEMA = { type: 'string', minLength: 1, maxLength: B.statusMax } as const;
const STOP_REASON_SCHEMA = { type: 'string', minLength: 1, maxLength: B.stopReasonMax } as const;
const TEXT_SCHEMA = { type: 'string', minLength: 1, maxLength: B.textMax } as const;
const OPTIONAL_TEXT_SCHEMA = { type: 'string', maxLength: B.textMax } as const;
const BODY_SCHEMA = { type: 'string', maxLength: B.bodyMax } as const;
const ISO_TIME_SCHEMA = { type: 'string', minLength: 1, maxLength: 64 } as const;
const NONNEG_INT = { type: 'integer', minimum: 0 } as const;

const SAFETY_MODE_SCHEMA = { type: 'string', enum: ['safe', 'balanced', 'auto'] } as const;
const SESSION_PHASE_SCHEMA = {
  type: 'string',
  enum: ['idle', 'running', 'completed', 'failed', 'cancelled', 'limited'],
} as const;
const BLOCK_REASON_SCHEMA = {
  type: 'string',
  enum: ['turn_active', 'provider_unavailable', 'session_unavailable', 'service_stopping'],
} as const;

export function createApiResponseSchema(dataSchema: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'requestId'],
    properties: {
      data: dataSchema,
      requestId: REQUEST_ID_SCHEMA,
    },
  };
}

export function createPageSchema(itemSchema: JsonSchema, maxItems: number): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: { type: 'array', maxItems, items: itemSchema },
      nextCursor: ID_SCHEMA,
    },
  };
}

const WORKSPACE_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'fingerprint'],
  properties: {
    name: WORKSPACE_NAME_SCHEMA,
    fingerprint: ID_SCHEMA,
  },
} as const;

const RUNTIME_CAPABILITIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'canCreateSession',
    'canSubmitTurn',
    'canChangeRuntime',
    'canCancelTurn',
    'canRespondToApproval',
  ],
  properties: {
    canCreateSession: { type: 'boolean' },
    canSubmitTurn: { type: 'boolean' },
    canChangeRuntime: { type: 'boolean' },
    canCancelTurn: { type: 'boolean' },
    canRespondToApproval: { type: 'boolean' },
    activeSessionId: ID_SCHEMA,
    activeTurnId: ID_SCHEMA,
    createSessionBlockedReason: BLOCK_REASON_SCHEMA,
    submitTurnBlockedReason: BLOCK_REASON_SCHEMA,
    changeRuntimeBlockedReason: BLOCK_REASON_SCHEMA,
  },
} as const;

const APPROVAL_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sessionId',
    'turnId',
    'toolCallId',
    'toolName',
    'approvalKey',
    'actionSummary',
    'riskReason',
    'allowedChoices',
  ],
  properties: {
    sessionId: ID_SCHEMA,
    turnId: ID_SCHEMA,
    toolCallId: ID_SCHEMA,
    toolName: TOOL_SCHEMA,
    approvalKey: { type: 'string', minLength: 1, maxLength: B.idMax },
    actionSummary: TEXT_SCHEMA,
    riskReason: TEXT_SCHEMA,
    allowedChoices: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      prefixItems: [{ const: 'deny' }, { const: 'allow_once' }, { const: 'allow_session' }],
      items: false,
    },
  },
} as const;

const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'shortId', 'title', 'updatedAt', 'turnCount', 'phase', 'model', 'safetyMode'],
  properties: {
    id: ID_SCHEMA,
    shortId: { type: 'string', minLength: 1, maxLength: 32 },
    title: TITLE_SCHEMA,
    updatedAt: ISO_TIME_SCHEMA,
    turnCount: NONNEG_INT,
    phase: SESSION_PHASE_SCHEMA,
    model: MODEL_SCHEMA,
    safetyMode: SAFETY_MODE_SCHEMA,
  },
} as const;

const SESSION_RUNTIME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'shortId',
    'title',
    'updatedAt',
    'turnCount',
    'phase',
    'model',
    'safetyMode',
    'context',
  ],
  properties: {
    ...SESSION_SUMMARY_SCHEMA.properties,
    context: {
      type: 'object',
      additionalProperties: false,
      required: ['usedApproxTokens', 'limitApproxTokens'],
      properties: {
        usedApproxTokens: NONNEG_INT,
        limitApproxTokens: NONNEG_INT,
      },
    },
    pendingApproval: APPROVAL_REQUEST_SCHEMA,
  },
} as const;

const SESSION_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session', 'capabilities'],
  properties: {
    session: SESSION_RUNTIME_SCHEMA,
    capabilities: RUNTIME_CAPABILITIES_SCHEMA,
  },
} as const;

const MODEL_LIST_SCHEMA = {
  type: 'array',
  maxItems: B.modelsMax,
  items: MODEL_SCHEMA,
} as const;

const PROVIDER_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseUrl', 'catalog', 'defaultModel', 'apiKeyConfigured', 'writable'],
  properties: {
    baseUrl: BASE_URL_SCHEMA,
    catalog: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'cachedModels'],
          properties: {
            source: { const: 'discover' },
            cachedModels: MODEL_LIST_SCHEMA,
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'models'],
          properties: {
            source: { const: 'manual' },
            models: MODEL_LIST_SCHEMA,
          },
        },
      ],
    },
    defaultModel: MODEL_SCHEMA,
    apiKeyConfigured: { type: 'boolean' },
    writable: { type: 'boolean' },
  },
} as const;

const UPDATE_PROVIDER_CONFIG_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseUrl', 'catalog', 'defaultModel'],
  properties: {
    baseUrl: BASE_URL_SCHEMA,
    catalog: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['source'],
          properties: { source: { const: 'discover' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'models'],
          properties: { source: { const: 'manual' }, models: MODEL_LIST_SCHEMA },
        },
      ],
    },
    defaultModel: MODEL_SCHEMA,
  },
} as const;

const BOOTSTRAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspace', 'provider', 'capabilities'],
  properties: {
    workspace: WORKSPACE_SUMMARY_SCHEMA,
    provider: PROVIDER_CONFIG_SCHEMA,
    capabilities: RUNTIME_CAPABILITIES_SCHEMA,
    suggestedSessionId: ID_SCHEMA,
  },
} as const;

const DISCOVER_MODELS_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseUrl'],
  properties: { baseUrl: BASE_URL_SCHEMA },
} as const;

const DISCOVERED_MODELS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['models', 'fetchedAt'],
  properties: {
    models: MODEL_LIST_SCHEMA,
    fetchedAt: ISO_TIME_SCHEMA,
  },
} as const;

const CREATE_SESSION_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: MODEL_SCHEMA,
    safetyMode: SAFETY_MODE_SCHEMA,
  },
} as const;

const UPDATE_SESSION_RUNTIME_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: MODEL_SCHEMA,
    safetyMode: SAFETY_MODE_SCHEMA,
  },
} as const;

const SUBMIT_TURN_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', minLength: 1, maxLength: B.bodyMax } },
} as const;

const CHAT_TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['turnId', 'startedAt', 'userText', 'responses', 'toolSummaries', 'status'],
  properties: {
    turnId: ID_SCHEMA,
    startedAt: ISO_TIME_SCHEMA,
    userText: { type: 'string', maxLength: B.bodyMax },
    responses: {
      type: 'array',
      maxItems: B.responsesMax,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'text', 'partial'],
        properties: {
          step: NONNEG_INT,
          text: BODY_SCHEMA,
          partial: { type: 'boolean' },
        },
      },
    },
    toolSummaries: {
      type: 'array',
      maxItems: B.toolSummariesMax,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['toolCallId', 'name', 'status'],
        properties: {
          toolCallId: ID_SCHEMA,
          name: TOOL_SCHEMA,
          status: {
            type: 'string',
            enum: ['running', 'awaiting_approval', 'completed', 'failed', 'denied', 'cancelled'],
          },
          resultSummary: OPTIONAL_TEXT_SCHEMA,
        },
      },
    },
    status: {
      type: 'string',
      enum: ['running', 'completed', 'failed', 'cancelled', 'limited'],
    },
    stopReason: STOP_REASON_SCHEMA,
  },
} as const;

const ACCEPTED_TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'turnId', 'acceptedAt'],
  properties: {
    sessionId: ID_SCHEMA,
    turnId: ID_SCHEMA,
    acceptedAt: ISO_TIME_SCHEMA,
  },
} as const;

const ACCEPTED_CANCELLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'turnId', 'state'],
  properties: {
    sessionId: ID_SCHEMA,
    turnId: ID_SCHEMA,
    state: { const: 'cancelling' },
  },
} as const;

const APPROVAL_DECISION_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['turnId', 'toolCallId', 'decision'],
  properties: {
    turnId: ID_SCHEMA,
    toolCallId: ID_SCHEMA,
    decision: { type: 'string', enum: ['deny', 'allow_once', 'allow_session'] },
  },
} as const;

const ACCEPTED_APPROVAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'turnId', 'toolCallId', 'outcome'],
  properties: {
    sessionId: ID_SCHEMA,
    turnId: ID_SCHEMA,
    toolCallId: ID_SCHEMA,
    outcome: { const: 'accepted' },
  },
} as const;

const TRACE_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'seq', 'turnId', 'time', 'type', 'label', 'status', 'hasDetails'],
  properties: {
    id: ID_SCHEMA,
    seq: NONNEG_INT,
    turnId: ID_SCHEMA,
    step: NONNEG_INT,
    time: ISO_TIME_SCHEMA,
    durationMs: NONNEG_INT,
    type: {
      type: 'string',
      enum: ['user', 'context', 'agent', 'tool', 'policy', 'approval', 'verification', 'turn'],
    },
    label: LABEL_SCHEMA,
    status: STATUS_SCHEMA,
    parameterSummary: OPTIONAL_TEXT_SCHEMA,
    resultSummary: OPTIONAL_TEXT_SCHEMA,
    hasDetails: { type: 'boolean' },
  },
} as const;

const TRACE_RECORD_DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'seq',
    'turnId',
    'time',
    'type',
    'label',
    'status',
    'hasDetails',
    'sections',
    'relatedRecordIds',
  ],
  properties: {
    ...TRACE_RECORD_SCHEMA.properties,
    sections: {
      type: 'array',
      maxItems: B.sectionsMax,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title'],
        properties: {
          key: { type: 'string', enum: ['metadata', 'parameters', 'result', 'limits', 'evidence'] },
          title: TITLE_SCHEMA,
          fields: {
            type: 'array',
            maxItems: B.fieldsMax,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'value'],
              properties: {
                label: LABEL_SCHEMA,
                value: TEXT_SCHEMA,
              },
            },
          },
          code: {
            type: 'object',
            additionalProperties: false,
            required: ['language', 'text', 'truncated'],
            properties: {
              language: { type: 'string', minLength: 1, maxLength: B.statusMax },
              text: BODY_SCHEMA,
              truncated: { type: 'boolean' },
            },
          },
          diff: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'text', 'truncated'],
            properties: {
              path: { type: 'string', minLength: 1, maxLength: B.titleMax },
              text: BODY_SCHEMA,
              truncated: { type: 'boolean' },
            },
          },
        },
      },
    },
    relatedRecordIds: {
      type: 'array',
      maxItems: B.relatedIdsMax,
      items: ID_SCHEMA,
    },
  },
} as const;

const PROJECTION_DELTA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['view'],
  properties: {
    view: SESSION_VIEW_SCHEMA,
    chatTurn: CHAT_TURN_SCHEMA,
    traceRecords: { type: 'array', maxItems: B.traceRecordsMax, items: TRACE_RECORD_SCHEMA },
  },
} as const;

const API_ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['error', 'requestId'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string', enum: [...WEB_ERROR_CODES] },
        message: TEXT_SCHEMA,
        retryable: { type: 'boolean' },
        fields: {
          type: 'object',
          maxProperties: B.fieldsMax,
          additionalProperties: { type: 'string', maxLength: B.textMax },
        },
      },
    },
    requestId: REQUEST_ID_SCHEMA,
  },
} as const;

const WEB_STREAM_EVENT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'sessionId', 'seq', 'delta'],
      properties: {
        type: { type: 'string', enum: ['session.updated', 'record.upsert'] },
        sessionId: ID_SCHEMA,
        seq: NONNEG_INT,
        delta: PROJECTION_DELTA_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'sessionId', 'seq', 'approval', 'delta'],
      properties: {
        type: { const: 'approval.pending' },
        sessionId: ID_SCHEMA,
        seq: NONNEG_INT,
        approval: APPROVAL_REQUEST_SCHEMA,
        delta: PROJECTION_DELTA_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'sessionId', 'seq', 'turnId', 'status', 'delta'],
      properties: {
        type: { const: 'turn.terminal' },
        sessionId: ID_SCHEMA,
        seq: NONNEG_INT,
        turnId: ID_SCHEMA,
        status: { type: 'string', enum: ['completed', 'failed', 'cancelled', 'limited'] },
        stopReason: STOP_REASON_SCHEMA,
        delta: PROJECTION_DELTA_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'sessionId', 'lastAvailableSeq', 'reason'],
      properties: {
        type: { const: 'resync.required' },
        sessionId: ID_SCHEMA,
        lastAvailableSeq: NONNEG_INT,
        reason: { type: 'string', enum: ['history_gap', 'projection_version_changed'] },
      },
    },
  ],
} as const;

export const WEB_JSON_SCHEMAS = {
  requestId: REQUEST_ID_SCHEMA,
  apiResponse: createApiResponseSchema({}),
  apiErrorResponse: API_ERROR_RESPONSE_SCHEMA,
  workspaceSummary: WORKSPACE_SUMMARY_SCHEMA,
  runtimeCapabilities: RUNTIME_CAPABILITIES_SCHEMA,
  sessionSummary: SESSION_SUMMARY_SCHEMA,
  approvalRequest: APPROVAL_REQUEST_SCHEMA,
  sessionRuntime: SESSION_RUNTIME_SCHEMA,
  sessionView: SESSION_VIEW_SCHEMA,
  providerConfig: PROVIDER_CONFIG_SCHEMA,
  bootstrap: BOOTSTRAP_SCHEMA,
  updateProviderConfigRequest: UPDATE_PROVIDER_CONFIG_REQUEST_SCHEMA,
  discoverModelsRequest: DISCOVER_MODELS_REQUEST_SCHEMA,
  discoveredModels: DISCOVERED_MODELS_SCHEMA,
  createSessionRequest: CREATE_SESSION_REQUEST_SCHEMA,
  chatTurn: CHAT_TURN_SCHEMA,
  updateSessionRuntimeRequest: UPDATE_SESSION_RUNTIME_REQUEST_SCHEMA,
  submitTurnRequest: SUBMIT_TURN_REQUEST_SCHEMA,
  acceptedTurn: ACCEPTED_TURN_SCHEMA,
  acceptedCancellation: ACCEPTED_CANCELLATION_SCHEMA,
  approvalDecisionRequest: APPROVAL_DECISION_REQUEST_SCHEMA,
  acceptedApproval: ACCEPTED_APPROVAL_SCHEMA,
  traceRecord: TRACE_RECORD_SCHEMA,
  traceRecordDetail: TRACE_RECORD_DETAIL_SCHEMA,
  projectionDelta: PROJECTION_DELTA_SCHEMA,
  webStreamEvent: WEB_STREAM_EVENT_SCHEMA,
  pageSessionSummary: createPageSchema(SESSION_SUMMARY_SCHEMA, B.sessionPageMax),
  pageChatTurn: createPageSchema(CHAT_TURN_SCHEMA, B.chatPageMax),
  pageTraceRecord: createPageSchema(TRACE_RECORD_SCHEMA, B.tracePageMax),
  sessionViewResponse: createApiResponseSchema(SESSION_VIEW_SCHEMA),
} as const satisfies Record<string, JsonSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaError(path: string, message: string): string {
  return path.length === 0 ? message : `${path}: ${message}`;
}

function validateAgainst(schema: JsonSchema, value: unknown, path: string): readonly string[] {
  if (schema['const'] !== undefined && value !== schema['const']) {
    return [schemaError(path, `expected ${JSON.stringify(schema['const'])}`)];
  }

  const type = schema['type'];
  if (type === 'boolean') {
    return typeof value === 'boolean' ? [] : [schemaError(path, 'expected boolean')];
  }
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return [schemaError(path, 'expected integer')];
    }
    const minimum = schema['minimum'];
    const maximum = schema['maximum'];
    if (typeof minimum === 'number' && value < minimum) {
      return [schemaError(path, `expected integer >= ${String(minimum)}`)];
    }
    if (typeof maximum === 'number' && value > maximum) {
      return [schemaError(path, `expected integer <= ${String(maximum)}`)];
    }
    return [];
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [schemaError(path, 'expected string')];
    const minLength = schema['minLength'];
    const maxLength = schema['maxLength'];
    const pattern = schema['pattern'];
    const enums = schema['enum'];
    if (typeof minLength === 'number' && value.length < minLength) {
      return [schemaError(path, `expected string length >= ${String(minLength)}`)];
    }
    if (typeof maxLength === 'number' && value.length > maxLength) {
      return [schemaError(path, `expected string length <= ${String(maxLength)}`)];
    }
    if (typeof pattern === 'string' && !new RegExp(pattern, 'u').test(value)) {
      return [schemaError(path, 'string does not match pattern')];
    }
    if (Array.isArray(enums) && !enums.includes(value)) {
      return [schemaError(path, 'string is not an allowed enum value')];
    }
    return [];
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [schemaError(path, 'expected array')];
    const minItems = schema['minItems'];
    const maxItems = schema['maxItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      return [schemaError(path, `expected array length >= ${String(minItems)}`)];
    }
    if (typeof maxItems === 'number' && value.length > maxItems) {
      return [schemaError(path, `expected array length <= ${String(maxItems)}`)];
    }
    const prefixItems = schema['prefixItems'];
    const errors: string[] = [];
    if (Array.isArray(prefixItems)) {
      for (const [index, itemSchema] of prefixItems.entries()) {
        if (!isRecord(itemSchema)) continue;
        errors.push(...validateAgainst(itemSchema, value[index], `${path}[${String(index)}]`));
      }
    }
    const items = schema['items'];
    if (items === false) {
      const prefixLength = Array.isArray(prefixItems) ? prefixItems.length : 0;
      if (value.length > prefixLength) {
        errors.push(schemaError(path, 'array has unexpected extra items'));
      }
    } else if (isRecord(items)) {
      for (const [index, item] of value.entries()) {
        errors.push(...validateAgainst(items, item, `${path}[${String(index)}]`));
      }
    }
    return errors;
  }
  if (type === 'object') {
    if (!isRecord(value)) return [schemaError(path, 'expected object')];
    const required = schema['required'];
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    const errors: string[] = [];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) {
          errors.push(schemaError(path, `missing required property ${key}`));
        }
      }
    }
    const maxProperties = schema['maxProperties'];
    if (typeof maxProperties === 'number' && Object.keys(value).length > maxProperties) {
      errors.push(schemaError(path, `expected object property count <= ${String(maxProperties)}`));
    }
    if (schema['additionalProperties'] === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(schemaError(path, `unexpected property ${key}`));
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || !isRecord(propertySchema)) continue;
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      errors.push(...validateAgainst(propertySchema, value[key], childPath));
    }
    const additional = schema['additionalProperties'];
    if (isRecord(additional)) {
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) continue;
        const childPath = path.length === 0 ? key : `${path}.${key}`;
        errors.push(...validateAgainst(additional, item, childPath));
      }
    }
    return errors;
  }

  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const matches = oneOf.filter(
      (candidate) => isRecord(candidate) && validateAgainst(candidate, value, path).length === 0,
    );
    return matches.length === 1
      ? []
      : [schemaError(path, 'value did not match exactly one schema branch')];
  }
  return [];
}

export function validateWebJsonSchema(schema: JsonSchema, value: unknown): readonly string[] {
  return validateAgainst(schema, value, '');
}

export function assertWebJsonSchema(schema: JsonSchema, value: unknown): void {
  const errors = validateWebJsonSchema(schema, value);
  if (errors.length > 0) {
    throw new Error(`Web JSON Schema validation failed: ${errors.join('; ')}`);
  }
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return validateWebJsonSchema(WEB_JSON_SCHEMAS.apiErrorResponse, value).length === 0;
}

export function isWebStreamEvent(value: unknown): value is WebStreamEvent {
  return validateWebJsonSchema(WEB_JSON_SCHEMAS.webStreamEvent, value).length === 0;
}

export const WEB_SCHEMA_EVENT_TYPES = WEB_STREAM_EVENT_TYPES;
