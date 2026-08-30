import { describe, expect, it } from 'vitest';

import type { ModelMessage, ModelRequest } from '../../../src/contracts/index.js';
import { toWireMessage, toWireRequest, toWireTool } from '../../../src/provider/request-mapping.js';

const request: ModelRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'goal' },
  ],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};

describe('request mapping', () => {
  it('maps a model request to wire format with streaming enabled', () => {
    const wire = toWireRequest(request) as Record<string, unknown>;

    expect(wire['model']).toBe('test-model');
    expect(wire['stream']).toBe(true);
    expect(wire['stream_options']).toEqual({ include_usage: true });
    expect(wire['messages']).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'goal' },
    ]);
  });

  it('maps tool definitions to OpenAI function tools', () => {
    const wire = toWireRequest(request) as Record<string, unknown>;
    const tools = wire['tools'] as readonly Record<string, unknown>[];

    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
  });

  it('omits the tools array entirely when there are no tools', () => {
    const wire = toWireRequest({ ...request, tools: [] }) as Record<string, unknown>;
    expect('tools' in wire).toBe(false);
  });

  it('passes through temperature and max output tokens when present', () => {
    const wire = toWireRequest({ ...request, temperature: 0.2, maxOutputTokens: 512 }) as Record<
      string,
      unknown
    >;
    expect(wire['temperature']).toBe(0.2);
    expect(wire['max_completion_tokens']).toBe(512);
  });

  it('omits optional model parameters when undefined', () => {
    const wire = toWireRequest(request) as Record<string, unknown>;
    expect('temperature' in wire).toBe(false);
    expect('max_completion_tokens' in wire).toBe(false);
  });

  it('serializes assistant tool calls with JSON string arguments', () => {
    const message: ModelMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } }],
    };
    expect(toWireMessage(message)).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
        },
      ],
    });
  });

  it('restores reasoning wire fields from an assistant message', () => {
    const message: ModelMessage = {
      role: 'assistant',
      content: '',
      reasoning: 'think',
      reasoningContent: 'hidden',
      reasoningDetails: [{ type: 'text', text: 'detail' }],
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } }],
    };
    expect(toWireMessage(message)).toEqual({
      role: 'assistant',
      content: '',
      reasoning: 'think',
      reasoning_content: 'hidden',
      reasoning_details: [{ type: 'text', text: 'detail' }],
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
        },
      ],
    });
  });

  it('keeps assistant messages without tool calls simple', () => {
    const message: ModelMessage = { role: 'assistant', content: 'plain text' };
    expect(toWireMessage(message)).toEqual({ role: 'assistant', content: 'plain text' });
  });

  it('maps tool results to tool messages with tool_call_id', () => {
    const message: ModelMessage = { role: 'tool', toolCallId: 'call-9', content: 'result text' };
    expect(toWireMessage(message)).toEqual({
      role: 'tool',
      tool_call_id: 'call-9',
      content: 'result text',
    });
  });

  it('maps undefined tool arguments to empty JSON object', () => {
    const tool = toWireTool({
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object' },
    });
    const message: ModelMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c', name: 'noop', arguments: undefined }],
    };
    const wire = toWireMessage(message) as Record<string, unknown>;
    const calls = wire['tool_calls'] as readonly { function: { arguments: string } }[];
    expect(calls[0]?.function.arguments).toBe('{}');
    expect(tool['type']).toBe('function');
  });
});
