import type { Readable, Writable } from 'node:stream';

import { ChatInputDecoder, type ChatInputReadResult } from './chat-input-decoder.js';

const BRACKETED_PASTE_ENABLE = '\u001b[?2004h';
const BRACKETED_PASTE_DISABLE = '\u001b[?2004l';

export interface ChatInputPort {
  start?(): void;
  pause?(): void;
  resume?(): void;
  read(): Promise<ChatInputReadResult>;
  close(): void;
}

export interface StreamChatInputOptions {
  readonly input: Readable;
  readonly output?: Writable;
  readonly bracketedPaste: boolean;
}

/**
 * Reads idle Chat batches from a stream. When `bracketedPaste` is false, each
 * Enter is one typed batch; multi-line paste atomicity is not available.
 */
export class StreamChatInput implements ChatInputPort {
  private readonly decoder = new ChatInputDecoder();
  private readonly queue: ChatInputReadResult[] = [];
  private readonly options: StreamChatInputOptions;
  private waiter: ((value: ChatInputReadResult) => void) | undefined;
  private closed = false;
  private listening = false;

  constructor(options: StreamChatInputOptions) {
    this.options = options;
  }

  start(): void {
    if (this.listening || this.closed) return;
    this.listening = true;
    if (this.options.bracketedPaste) {
      this.options.output?.write(BRACKETED_PASTE_ENABLE);
    }
    this.options.input.setEncoding('utf8');
    this.options.input.on('data', this.onData);
    this.options.input.on('end', this.onEnd);
    this.options.input.resume();
  }

  pause(): void {
    if (!this.listening) return;
    this.options.input.off('data', this.onData);
    this.options.input.pause();
    this.listening = false;
  }

  resume(): void {
    if (this.closed || this.listening) return;
    this.listening = true;
    this.options.input.on('data', this.onData);
    this.options.input.resume();
  }

  read(): Promise<ChatInputReadResult> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.closed) return Promise.resolve({ kind: 'eof' });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pause();
    this.options.input.off('end', this.onEnd);
    if (this.options.bracketedPaste) {
      this.options.output?.write(BRACKETED_PASTE_DISABLE);
    }
    this.push({ kind: 'eof' });
  }

  private readonly onData = (chunk: string | Buffer): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const event of this.decoder.push(text)) this.push(event);
  };

  private readonly onEnd = (): void => {
    for (const event of this.decoder.end()) this.push(event);
    this.closed = true;
  };

  private push(event: ChatInputReadResult): void {
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(event);
      return;
    }
    this.queue.push(event);
  }
}

export class ScriptedChatInput implements ChatInputPort {
  private readonly events: readonly ChatInputReadResult[];
  private index = 0;

  constructor(events: readonly ChatInputReadResult[]) {
    this.events = events;
  }

  read(): Promise<ChatInputReadResult> {
    const event = this.events[this.index];
    this.index += 1;
    return Promise.resolve(event ?? { kind: 'eof' });
  }

  close(): void {
    this.index = this.events.length;
  }
}
