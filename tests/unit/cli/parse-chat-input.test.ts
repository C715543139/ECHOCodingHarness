import { describe, expect, it } from 'vitest';

import { parseIdleInput } from '../../../src/cli/parse-chat-input.js';

describe('parseIdleInput', () => {
  it('parses typed slash commands and rejects unknown or unsupported arguments', () => {
    expect(parseIdleInput('/help', 'typed')).toEqual({ kind: 'slash', name: 'help' });
    expect(parseIdleInput('/status', 'typed')).toEqual({ kind: 'slash', name: 'status' });
    expect(parseIdleInput('/quit', 'typed')).toEqual({ kind: 'slash', name: 'quit' });
    expect(parseIdleInput('/model', 'typed')).toEqual({ kind: 'slash', name: 'model' });
    expect(parseIdleInput('/model refresh', 'typed')).toEqual({
      kind: 'slash',
      name: 'model',
      argument: 'refresh',
    });
    expect(parseIdleInput('/model deepseek-reasoner', 'typed')).toEqual({
      kind: 'slash',
      name: 'model',
      argument: 'deepseek-reasoner',
    });
    expect(parseIdleInput('/safety', 'typed')).toEqual({ kind: 'slash', name: 'safety' });
    expect(parseIdleInput('/safety auto', 'typed')).toEqual({
      kind: 'slash',
      name: 'safety',
      argument: 'auto',
    });
    expect(parseIdleInput('/foo', 'typed')).toMatchObject({ kind: 'error', code: 'UNKNOWN_SLASH' });
    expect(parseIdleInput('/model reset', 'typed')).toMatchObject({
      kind: 'error',
      code: 'INVALID_SLASH_ARGUMENT',
    });
    expect(parseIdleInput('/safety reset', 'typed')).toMatchObject({
      kind: 'error',
      code: 'INVALID_SLASH_ARGUMENT',
    });
    expect(parseIdleInput('/help please', 'typed')).toMatchObject({
      kind: 'error',
      code: 'INVALID_SLASH_ARGUMENT',
    });
  });

  it('never treats paste as a slash command, including /help', () => {
    expect(parseIdleInput('/help', 'paste')).toEqual({
      kind: 'message',
      text: '/help',
      source: 'paste',
    });
    expect(parseIdleInput('/model reset\n/quit', 'paste')).toEqual({
      kind: 'message',
      text: '/model reset\n/quit',
      source: 'paste',
    });
  });

  it('treats empty submissions as empty and other typed text as a message', () => {
    expect(parseIdleInput('   ', 'typed')).toEqual({ kind: 'empty' });
    expect(parseIdleInput('', 'paste')).toEqual({ kind: 'empty' });
    expect(parseIdleInput('fix the tests', 'typed')).toEqual({
      kind: 'message',
      text: 'fix the tests',
      source: 'typed',
    });
    expect(parseIdleInput('/help\nstill a message', 'typed')).toEqual({
      kind: 'message',
      text: '/help\nstill a message',
      source: 'typed',
    });
  });
});
