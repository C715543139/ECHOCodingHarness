import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  type ChatInputSource,
} from '../contracts/chat-input.js';

export type ChatInputReadResult =
  | Readonly<{ kind: 'batch'; text: string; source: ChatInputSource }>
  | Readonly<{ kind: 'interrupt' }>
  | Readonly<{ kind: 'eof' }>;

const PASTE_MARKERS = [BRACKETED_PASTE_START, BRACKETED_PASTE_END] as const;

/**
 * Hosts that do not emit CSI 200~/201~ cannot promise that a multi-line paste
 * stays one batch. Enter still submits exactly one typed batch.
 */
export const BRACKETED_PASTE_REQUIRED_FOR_MULTILINE_ATOMICITY =
  'Without bracketed paste, each Enter submits one typed batch and a multi-line paste may become multiple Turns.';

function heldPasteMarker(buffer: string): boolean {
  const escapeIndex = buffer.lastIndexOf('\u001b');
  if (escapeIndex === -1) return false;
  const tail = buffer.slice(escapeIndex);
  return PASTE_MARKERS.some((marker) => marker.startsWith(tail) && tail !== marker);
}

function nextDelimiter(
  buffer: string,
  inPaste: boolean,
): Readonly<{ index: number; kind: 'start' | 'end' | 'newline' | 'interrupt' }> | undefined {
  const interruptAt = buffer.indexOf('\u0003');
  const startAt = inPaste ? -1 : buffer.indexOf(BRACKETED_PASTE_START);
  const endAt = inPaste ? buffer.indexOf(BRACKETED_PASTE_END) : -1;
  const crlfAt = inPaste ? -1 : buffer.indexOf('\r\n');
  const crAt = inPaste ? -1 : buffer.indexOf('\r');
  const lfAt = inPaste ? -1 : buffer.indexOf('\n');

  const candidates: { index: number; kind: 'start' | 'end' | 'newline' | 'interrupt' }[] = [];
  if (interruptAt >= 0) candidates.push({ index: interruptAt, kind: 'interrupt' });
  if (startAt >= 0) candidates.push({ index: startAt, kind: 'start' });
  if (endAt >= 0) candidates.push({ index: endAt, kind: 'end' });
  if (crlfAt >= 0) candidates.push({ index: crlfAt, kind: 'newline' });
  else if (crAt >= 0) candidates.push({ index: crAt, kind: 'newline' });
  else if (lfAt >= 0) candidates.push({ index: lfAt, kind: 'newline' });

  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => left.index - right.index);
  return candidates[0];
}

function newlineLength(buffer: string, index: number): number {
  return buffer.startsWith('\r\n', index) ? 2 : 1;
}

function emitBatch(text: string, source: ChatInputSource, events: ChatInputReadResult[]): void {
  events.push({ kind: 'batch', text, source });
}

/**
 * Incremental decoder for idle Chat input. Bracketed paste is the only
 * multi-line boundary: one CSI 200~/201~ pair is at most one user Turn.
 */
export class ChatInputDecoder {
  private buffer = '';
  private paste: string | undefined;

  push(chunk: string): ChatInputReadResult[] {
    this.buffer += chunk;
    const events: ChatInputReadResult[] = [];
    this.drain(events);
    return events;
  }

  end(): ChatInputReadResult[] {
    const events: ChatInputReadResult[] = [];
    this.drain(events);
    if (this.paste !== undefined) {
      emitBatch(this.paste + this.buffer, 'paste', events);
      this.paste = undefined;
      this.buffer = '';
    } else if (this.buffer.length > 0) {
      emitBatch(this.buffer, 'typed', events);
      this.buffer = '';
    }
    events.push({ kind: 'eof' });
    return events;
  }

  private drain(events: ChatInputReadResult[]): void {
    while (this.buffer.length > 0) {
      if (heldPasteMarker(this.buffer)) return;
      const inPaste = this.paste !== undefined;
      const delimiter = nextDelimiter(this.buffer, inPaste);
      if (delimiter === undefined) return;

      if (delimiter.kind === 'interrupt') {
        this.buffer = '';
        this.paste = undefined;
        events.push({ kind: 'interrupt' });
        return;
      }

      if (delimiter.kind === 'start') {
        const typed = this.buffer.slice(0, delimiter.index);
        this.buffer = this.buffer.slice(delimiter.index + BRACKETED_PASTE_START.length);
        if (typed.length > 0) emitBatch(typed, 'typed', events);
        this.paste = '';
        continue;
      }

      if (delimiter.kind === 'end') {
        const pasted = (this.paste ?? '') + this.buffer.slice(0, delimiter.index);
        this.buffer = this.buffer.slice(delimiter.index + BRACKETED_PASTE_END.length);
        this.paste = undefined;
        emitBatch(pasted, 'paste', events);
        continue;
      }

      const length = newlineLength(this.buffer, delimiter.index);
      const line = this.buffer.slice(0, delimiter.index);
      this.buffer = this.buffer.slice(delimiter.index + length);
      emitBatch(line, 'typed', events);
    }
  }
}
