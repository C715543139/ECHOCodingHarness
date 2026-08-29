import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../../../src/contracts/index.js';
import { ScriptedChatInput, StreamChatInput } from '../../../src/cli/chat-input-reader.js';

describe('Chat input adapter', () => {
  it('assembles a bracketed paste from stream chunks into one batch', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk));
    const reader = new StreamChatInput({ input, output, bracketedPaste: true });
    reader.start();
    expect(Buffer.concat(written).toString('utf8')).toContain('\u001b[?2004h');

    const pending = reader.read();
    input.write(`${BRACKETED_PASTE_START}first\n`);
    input.write(`second${BRACKETED_PASTE_END}`);
    await expect(pending).resolves.toEqual({
      kind: 'batch',
      text: 'first\nsecond',
      source: 'paste',
    });
    reader.close();
  });

  it('treats each Enter as one typed batch when bracketed paste is disabled', async () => {
    const input = new PassThrough();
    const reader = new StreamChatInput({ input, bracketedPaste: false });
    reader.start();
    const first = reader.read();
    input.write('line-one\nline-two\n');
    await expect(first).resolves.toEqual({
      kind: 'batch',
      text: 'line-one',
      source: 'typed',
    });
    await expect(reader.read()).resolves.toEqual({
      kind: 'batch',
      text: 'line-two',
      source: 'typed',
    });
    reader.pause();
    reader.resume();
    reader.close();
    await expect(reader.read()).resolves.toEqual({ kind: 'eof' });
  });

  it('replays scripted batches for deterministic Chat tests', async () => {
    const scripted = new ScriptedChatInput([
      { kind: 'batch', text: '/help', source: 'typed' },
      { kind: 'interrupt' },
    ]);
    await expect(scripted.read()).resolves.toEqual({
      kind: 'batch',
      text: '/help',
      source: 'typed',
    });
    await expect(scripted.read()).resolves.toEqual({ kind: 'interrupt' });
    scripted.close();
    await expect(scripted.read()).resolves.toEqual({ kind: 'eof' });
  });
});
