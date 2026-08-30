import type { ModelMessage, ModelRequest, ModelToolDefinition } from '../contracts/model.js';

type WireMessage = Record<string, unknown>;

interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

function serializeToolCallArguments(value: unknown): string {
  return value === undefined ? '{}' : JSON.stringify(value);
}

function isAssistantMessage(
  message: ModelMessage,
): message is Extract<ModelMessage, { role: 'assistant' }> {
  return message.role === 'assistant';
}

function isToolMessage(message: ModelMessage): message is Extract<ModelMessage, { role: 'tool' }> {
  return message.role === 'tool';
}

export function toWireMessage(message: ModelMessage): WireMessage {
  if (isToolMessage(message)) {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (isAssistantMessage(message)) {
    const toolCalls: readonly WireToolCall[] | undefined = message.toolCalls?.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: serializeToolCallArguments(call.arguments) },
    }));
    const wire: WireMessage = { role: 'assistant', content: message.content };
    if (toolCalls !== undefined) {
      wire['tool_calls'] = toolCalls;
    }
    if (message.reasoning !== undefined) {
      wire['reasoning'] = message.reasoning;
    }
    if (message.reasoningContent !== undefined) {
      wire['reasoning_content'] = message.reasoningContent;
    }
    if (message.reasoningDetails !== undefined) {
      wire['reasoning_details'] = message.reasoningDetails;
    }
    return wire;
  }
  return { role: message.role, content: message.content };
}

export function toWireTool(tool: ModelToolDefinition): WireMessage {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

export function toWireRequest(request: ModelRequest): WireMessage {
  const wire: WireMessage = {
    model: request.model,
    messages: request.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools.length > 0) {
    wire['tools'] = request.tools.map(toWireTool);
  }
  if (request.temperature !== undefined) {
    wire['temperature'] = request.temperature;
  }
  if (request.maxOutputTokens !== undefined) {
    wire['max_completion_tokens'] = request.maxOutputTokens;
  }
  return wire;
}
