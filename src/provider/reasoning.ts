import type { ModelReasoning, ModelReasoningDelta } from '../contracts/model.js';

export function isJsonSerializable(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return false;
    JSON.parse(serialized);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function extractReasoningDelta(delta: unknown): ModelReasoningDelta | undefined {
  const record = asRecord(delta);
  if (record === undefined) return undefined;

  const reasoning = optionalString(record['reasoning']);
  const reasoningContent = optionalString(
    record['reasoning_content'] ?? record['reasoningContent'],
  );
  const rawDetails = record['reasoning_details'] ?? record['reasoningDetails'];
  const reasoningDetails =
    Array.isArray(rawDetails) && isJsonSerializable(rawDetails)
      ? (rawDetails as readonly unknown[])
      : undefined;

  if (reasoning === undefined && reasoningContent === undefined && reasoningDetails === undefined) {
    return undefined;
  }
  return {
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(reasoningContent === undefined ? {} : { reasoningContent }),
    ...(reasoningDetails === undefined ? {} : { reasoningDetails }),
  };
}

const PLAIN_TEXT_DETAIL_KEYS = new Set(['type', 'text', 'format', 'index']);

type PlainTextReasoningDetail = Readonly<Record<string, unknown>> &
  Readonly<{ type: 'reasoning.text'; text: string }>;

function isRedundantPlainTextDetail(value: unknown): value is PlainTextReasoningDetail {
  const record = asRecord(value);
  return (
    record !== undefined &&
    Object.keys(record).every((key) => PLAIN_TEXT_DETAIL_KEYS.has(key)) &&
    record['type'] === 'reasoning.text' &&
    typeof record['text'] === 'string'
  );
}

export function aggregateReasoning(
  deltas: readonly ModelReasoningDelta[],
): ModelReasoning | undefined {
  let reasoning: string | undefined;
  let reasoningContent: string | undefined;
  const details: unknown[] = [];
  let observed = false;

  for (const delta of deltas) {
    if (delta.reasoning !== undefined) {
      observed = true;
      reasoning = `${reasoning ?? ''}${delta.reasoning}`;
    }
    if (delta.reasoningContent !== undefined) {
      observed = true;
      reasoningContent = `${reasoningContent ?? ''}${delta.reasoningContent}`;
    }
    if (delta.reasoningDetails !== undefined) {
      observed = true;
      details.push(...delta.reasoningDetails);
    }
  }

  if (!observed) return undefined;

  let canonicalReasoning = reasoning;
  let omitDetails = false;
  if (details.length > 0 && details.every(isRedundantPlainTextDetail)) {
    const joined = details.map((detail) => detail.text).join('');
    if (joined.length > 0) {
      if (reasoning === undefined && reasoningContent === undefined) {
        canonicalReasoning = joined;
        omitDetails = true;
      } else if (joined === reasoning || joined === reasoningContent) {
        omitDetails = true;
      }
    }
  }

  const payload: ModelReasoning = {
    ...(canonicalReasoning === undefined ? {} : { reasoning: canonicalReasoning }),
    ...(reasoningContent === undefined ? {} : { reasoningContent }),
    ...(details.length === 0 || omitDetails ? {} : { reasoningDetails: details }),
  };
  if (
    payload.reasoning === undefined &&
    payload.reasoningContent === undefined &&
    payload.reasoningDetails === undefined
  ) {
    return undefined;
  }
  return payload;
}

export function isReasoningPayload(value: unknown): value is ModelReasoning {
  const record = asRecord(value);
  if (record === undefined) return false;
  const allowed = new Set(['reasoning', 'reasoningContent', 'reasoningDetails']);
  const keys = Object.keys(record);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!allowed.has(key)) return false;
  }
  if (record['reasoning'] !== undefined && typeof record['reasoning'] !== 'string') return false;
  if (record['reasoningContent'] !== undefined && typeof record['reasoningContent'] !== 'string') {
    return false;
  }
  if (record['reasoningDetails'] !== undefined) {
    if (
      !Array.isArray(record['reasoningDetails']) ||
      !isJsonSerializable(record['reasoningDetails'])
    ) {
      return false;
    }
  }
  return (
    record['reasoning'] !== undefined ||
    record['reasoningContent'] !== undefined ||
    record['reasoningDetails'] !== undefined
  );
}
