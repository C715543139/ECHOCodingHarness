import type { ChatIdleInput, ChatInputSource } from '../contracts/chat-input.js';
import { P1_SLASH_COMMANDS } from '../contracts/chat-input.js';
import type { SafetyMode } from '../contracts/safety.js';
import { SAFETY_MODES } from '../config/schema.js';

const HELP_LINES = [
  '/help',
  '/status',
  '/model',
  '/model <model-id>',
  '/model refresh',
  '/safety',
  '/safety safe|balanced|auto',
  '/quit',
] as const;

export const CHAT_SLASH_HELP_LINES: readonly string[] = HELP_LINES;

function unknownSlash(command: string): ChatIdleInput {
  return {
    kind: 'error',
    code: 'UNKNOWN_SLASH',
    message: `Unknown command ${command}. Type /help for the list of commands.`,
  };
}

function invalidSlash(message: string): ChatIdleInput {
  return {
    kind: 'error',
    code: 'INVALID_SLASH_ARGUMENT',
    message,
  };
}

function parseTypedSlash(line: string): ChatIdleInput {
  const trimmed = line.trimEnd();
  const parts = trimmed
    .slice(1)
    .split(/\s+/u)
    .filter((part) => part.length > 0);
  const name = parts[0]?.toLocaleLowerCase('en-US');
  if (name === undefined) {
    return unknownSlash(trimmed);
  }
  if (!(P1_SLASH_COMMANDS as readonly string[]).includes(name)) {
    return unknownSlash(`/${name}`);
  }

  const rest = parts.slice(1);
  if (name === 'help' || name === 'status' || name === 'quit') {
    if (rest.length > 0) {
      return invalidSlash(`/${name} does not take arguments.`);
    }
    return { kind: 'slash', name };
  }

  if (name === 'model') {
    if (rest.length === 0) {
      return { kind: 'slash', name: 'model' };
    }
    if (rest.length === 1 && rest[0] === 'refresh') {
      return { kind: 'slash', name: 'model', argument: 'refresh' };
    }
    if (rest.length === 1 && rest[0] !== undefined) {
      if (rest[0] === 'reset') {
        return invalidSlash('/model reset is not supported.');
      }
      return { kind: 'slash', name: 'model', argument: rest[0] };
    }
    return invalidSlash('Usage: /model, /model <model-id>, or /model refresh.');
  }

  if (rest.length === 0) {
    return { kind: 'slash', name: 'safety' };
  }
  if (rest.length === 1 && rest[0] !== undefined) {
    const mode = rest[0].toLocaleLowerCase('en-US');
    if (mode === 'reset') {
      return invalidSlash('/safety reset is not supported.');
    }
    if ((SAFETY_MODES as readonly string[]).includes(mode)) {
      return { kind: 'slash', name: 'safety', argument: mode as SafetyMode };
    }
  }
  return invalidSlash('Usage: /safety or /safety safe|balanced|auto.');
}

/**
 * Parse one idle submission. Slash commands require a typed single line.
 * Paste batches are always messages, even when they look like /help.
 */
export function parseIdleInput(text: string, source: ChatInputSource): ChatIdleInput {
  if (text.trim().length === 0) {
    return { kind: 'empty' };
  }
  if (source === 'paste') {
    return { kind: 'message', text, source: 'paste' };
  }
  if (text.includes('\n') || text.includes('\r')) {
    return { kind: 'message', text, source: 'typed' };
  }
  if (!text.startsWith('/')) {
    return { kind: 'message', text, source: 'typed' };
  }
  return parseTypedSlash(text);
}
