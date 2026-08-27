import type { ModelFinishReason } from '../contracts/model.js';

export type WireFinishReason = string | null | undefined;

const FINISH_REASON_MAP: Readonly<Record<string, ModelFinishReason>> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'content_filter',
  function_call: 'tool_calls',
};

export function mapFinishReason(reason: WireFinishReason): ModelFinishReason {
  if (reason === null || reason === undefined) {
    return 'unknown';
  }
  return FINISH_REASON_MAP[reason] ?? 'unknown';
}
