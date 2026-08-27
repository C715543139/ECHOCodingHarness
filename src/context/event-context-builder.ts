import type {
  ContextBudget,
  ContextBuilder,
  ContextProjection,
  ContextTruncation,
  EchoEvent,
  ModelMessage,
} from '../contracts/index.js';

import { approxTokensForText, approxTokensForValue } from './approx-tokens.js';
import { truncateToLimit } from './trim.js';

export interface EventContextBuilderOptions {
  readonly systemPrompt: string;
  readonly workspaceSummary?: string;
  readonly toolResultMaxChars?: number;
}

interface ToolResultContent {
  readonly content: string;
  readonly size: number;
}

interface StepDigest {
  readonly index: number;
  readonly text: string;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: unknown }[];
  readonly toolResults: readonly ToolResultContent[];
}

const TOOL_RESULT_DEFAULT_MAX_CHARS = 4_000;
const SUMMARY_PER_EVENT_MAX_CHARS = 400;

function toolResultContent(
  event: Extract<
    EchoEvent,
    { type: 'tool.completed' | 'tool.failed' | 'tool.denied' | 'tool.cancelled' }
  >,
): ToolResultContent | undefined {
  const result = event.payload.result;
  if (event.type === 'tool.completed') {
    return {
      content: result.content ?? result.summary,
      size: (result.content ?? result.summary).length,
    };
  }
  return { content: result.summary, size: result.summary.length };
}

function renderSummaryLine(label: string, value: string): string {
  const text =
    value.length > SUMMARY_PER_EVENT_MAX_CHARS
      ? `${value.slice(0, SUMMARY_PER_EVENT_MAX_CHARS)}...`
      : value;
  return `- ${label}: ${text}`;
}

function renderStepDigest(digest: StepDigest): string {
  const lines: string[] = [`Step ${digest.index}:`];
  for (const call of digest.toolCalls) {
    const args =
      approxTokensForValue(call.arguments) <= 200
        ? JSON.stringify(call.arguments)
        : '[omitted arguments]';
    lines.push(renderSummaryLine(`tool ${call.name}`, args));
  }
  if (digest.text.trim().length > 0) {
    lines.push(renderSummaryLine('assistant', digest.text));
  }
  for (const result of digest.toolResults) {
    lines.push(renderSummaryLine('result', result.content));
  }
  return lines.join('\n');
}

function messageTokens(message: ModelMessage): number {
  const base = approxTokensForText(message.content ?? '');
  if (message.role === 'assistant') {
    return (
      base + (message.toolCalls ?? []).reduce((sum, call) => sum + approxTokensForValue(call), 0)
    );
  }
  return base;
}

function projectionTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function collectStepDigests(events: readonly EchoEvent[]): readonly StepDigest[] {
  const digests: StepDigest[] = [];
  let current: {
    index: number;
    text: string;
    toolCalls: { name: string; arguments: unknown }[];
    toolResults: ToolResultContent[];
  } | null = null;

  for (const event of events) {
    if (event.type === 'step.started') {
      if (current !== null) {
        digests.push(current);
      }
      current = { index: event.payload.step, text: '', toolCalls: [], toolResults: [] };
      continue;
    }
    if (current === null) {
      continue;
    }
    switch (event.type) {
      case 'model.text_delta': {
        current.text += event.payload.delta;
        break;
      }
      case 'model.tool_call': {
        current.toolCalls.push({
          name: event.payload.call.name,
          arguments: event.payload.call.arguments,
        });
        break;
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.denied':
      case 'tool.cancelled': {
        const content = toolResultContent(event);
        if (content !== undefined) {
          current.toolResults.push(content);
        }
        break;
      }
      default:
        break;
    }
  }
  if (current !== null) {
    digests.push(current);
  }
  return digests;
}

interface ConversationTurn {
  assistant: { content: string; toolCalls: { id: string; name: string; arguments: unknown }[] };
  toolMessages: { toolCallId: string; status: string; content: string }[];
}

function collectConversation(events: readonly EchoEvent[]): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'model.text_delta': {
        if (current === null) {
          current = { assistant: { content: '', toolCalls: [] }, toolMessages: [] };
        }
        current.assistant.content += event.payload.delta;
        break;
      }
      case 'model.tool_call': {
        if (current === null) {
          current = { assistant: { content: '', toolCalls: [] }, toolMessages: [] };
        }
        current.assistant.toolCalls = [
          ...current.assistant.toolCalls,
          {
            id: event.payload.call.id,
            name: event.payload.call.name,
            arguments: event.payload.call.arguments,
          },
        ];
        break;
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.denied':
      case 'tool.cancelled': {
        if (current === null) {
          break;
        }
        const result = event.payload.result;
        const status = result.status;
        const summary = result.content ?? result.summary;
        current.toolMessages = [
          ...current.toolMessages,
          { toolCallId: result.toolCallId, status, content: summary },
        ];
        break;
      }
      case 'step.started':
      case 'turn.started': {
        if (current !== null) {
          turns.push(current);
          current = null;
        }
        break;
      }
      default:
        break;
    }
  }
  if (current !== null) {
    turns.push(current);
  }
  return turns;
}

function conversationMessages(
  turn: ConversationTurn,
  toolResultMaxChars: number,
  truncations: ContextTruncation[],
): readonly ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: turn.assistant.content,
      ...(turn.assistant.toolCalls.length > 0
        ? {
            toolCalls: turn.assistant.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          }
        : {}),
    },
  ];
  for (const toolMessage of turn.toolMessages) {
    const trimmed = truncateToLimit(toolMessage.content, toolResultMaxChars);
    if (trimmed.truncated) {
      truncations.push({
        reason: 'tool result exceeded context limit',
        originalSize: trimmed.originalSize,
        keptSize: trimmed.keptSize,
      });
    }
    messages.push({
      role: 'tool',
      toolCallId: toolMessage.toolCallId,
      content: `[${toolMessage.status}] ${trimmed.text}`,
    });
  }
  return messages;
}

function goalMessage(events: readonly EchoEvent[]): ModelMessage | undefined {
  const turnStarted = [...events]
    .reverse()
    .find(
      (event): event is Extract<EchoEvent, { type: 'turn.started' }> =>
        event.type === 'turn.started',
    );
  return turnStarted === undefined
    ? undefined
    : { role: 'user', content: turnStarted.payload.goal };
}

function budgetForMessages(budget: ContextBudget): number {
  return Math.max(1, budget.maxApproxTokens - budget.reservedOutputTokens);
}

/**
 * Deterministic projection of session events into model messages:
 * system constraints and the current goal are never dropped, recent steps
 * keep verbatim tool traffic, older steps collapse into summaries, and any
 * truncation is recorded in the returned projection.
 */
export class EventContextBuilder implements ContextBuilder {
  private readonly systemPrompt: string;
  private readonly workspaceSummary: string | undefined;
  private readonly toolResultMaxChars: number;

  constructor(options: EventContextBuilderOptions) {
    this.systemPrompt = options.systemPrompt;
    this.workspaceSummary = options.workspaceSummary;
    this.toolResultMaxChars = options.toolResultMaxChars ?? TOOL_RESULT_DEFAULT_MAX_CHARS;
  }

  build(events: readonly EchoEvent[], budget: ContextBudget): ContextProjection {
    const truncations: ContextTruncation[] = [];
    const goal = goalMessage(events);
    const system: ModelMessage = { role: 'system', content: this.systemPrompt };
    const fixedMessages: ModelMessage[] = [system];
    if (this.workspaceSummary !== undefined) {
      fixedMessages.push({ role: 'system', content: this.workspaceSummary });
    }
    if (goal !== undefined) {
      fixedMessages.push(goal);
    }

    const digests = collectStepDigests(events);
    const conversation = collectConversation(events);
    const turnsWithDigests = conversation.slice(-digests.length || undefined);

    const availableBudget = budgetForMessages(budget);
    const fixedTokens = projectionTokens(fixedMessages);
    const remaining = Math.max(0, availableBudget - fixedTokens);

    const keptMessages: ModelMessage[] = [];
    let used = 0;
    let start = turnsWithDigests.length;
    for (let index = turnsWithDigests.length - 1; index >= 0; index -= 1) {
      const messages = conversationMessages(
        turnsWithDigests[index] as ConversationTurn,
        this.toolResultMaxChars,
        truncations,
      );
      const cost = projectionTokens(messages);
      if (used + cost > remaining) {
        break;
      }
      used += cost;
      keptMessages.unshift(...messages);
      start = index;
    }

    const omittedTurns = turnsWithDigests.slice(0, start);
    const omittedEventCount = omittedTurns.reduce((sum, turn) => {
      return (
        sum +
        1 +
        turn.assistant.toolCalls.length +
        turn.toolMessages.length +
        (turn.assistant.content.length > 0 ? 1 : 0)
      );
    }, 0);

    if (omittedTurns.length > 0) {
      const summaryText = omittedTurns
        .map((_, index) => renderStepDigest(digests[index] as StepDigest))
        .join('\n');
      const summaryMessage: ModelMessage = { role: 'user', content: summaryText };
      const summaryTokens = projectionTokens([summaryMessage]);
      if (used + summaryTokens <= remaining) {
        keptMessages.unshift(summaryMessage);
      } else {
        const trimmed = truncateToLimit(summaryText, Math.max(0, remaining - used) * 4);
        truncations.push({
          reason: 'older step summaries exceeded remaining budget',
          originalSize: trimmed.originalSize,
          keptSize: trimmed.keptSize,
        });
        keptMessages.unshift({ role: 'user', content: trimmed.text });
      }
    }

    const messages = [...fixedMessages, ...keptMessages];
    return {
      messages,
      approximateTokens: projectionTokens(messages),
      omittedEventCount,
      truncations,
    };
  }
}
