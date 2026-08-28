import { readFile, stat } from 'node:fs/promises';

import { assertNotAborted, FileToolError } from './errors.js';

const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024;

export interface TextFile {
  readonly content: string;
  readonly sizeBytes: number;
}

export interface TruncatedText {
  readonly content: string;
  readonly omittedChars: number;
  readonly truncated: boolean;
}

export async function readTextFile(
  absolutePath: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<TextFile> {
  assertNotAborted(signal);
  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) {
    throw new FileToolError(
      'tool_execution',
      'PATH_NOT_FILE',
      'The requested workspace path is not a regular file.',
      { path: relativePath },
    );
  }
  if (fileStats.size > MAX_TEXT_FILE_BYTES) {
    throw new FileToolError(
      'tool_execution',
      'FILE_TOO_LARGE',
      'The requested file is too large for a text file tool.',
      { path: relativePath, sizeBytes: fileStats.size },
    );
  }

  const buffer = await readFile(absolutePath, { signal });
  if (isBinary(buffer)) {
    throw new FileToolError(
      'tool_execution',
      'BINARY_FILE',
      'Binary files are not supported by text file tools.',
      { path: relativePath, sizeBytes: buffer.byteLength },
    );
  }

  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(buffer),
      sizeBytes: buffer.byteLength,
    };
  } catch {
    throw new FileToolError('tool_execution', 'BINARY_FILE', 'The file is not valid UTF-8 text.', {
      path: relativePath,
      sizeBytes: buffer.byteLength,
    });
  }
}

export function truncateHeadTail(text: string, maximumCharacters: number): TruncatedText {
  const limit = Math.max(0, Math.floor(maximumCharacters));
  if (text.length <= limit) {
    return { content: text, omittedChars: 0, truncated: false };
  }
  if (limit === 0) {
    return { content: '', omittedChars: text.length, truncated: true };
  }

  let marker = '';
  let retainedCharacters = limit;
  let omittedChars = text.length - retainedCharacters;
  const candidateMarker = `\n… ${omittedChars} chars omitted …\n`;
  if (candidateMarker.length < limit) {
    marker = candidateMarker;
    retainedCharacters = limit - marker.length;
    omittedChars = text.length - retainedCharacters;
    marker = `\n… ${omittedChars} chars omitted …\n`;
    retainedCharacters = Math.max(0, limit - marker.length);
    omittedChars = text.length - retainedCharacters;
  }

  const headLength = Math.ceil(retainedCharacters / 2);
  const tailLength = Math.floor(retainedCharacters / 2);
  return {
    content: `${text.slice(0, headLength)}${marker}${tailLength === 0 ? '' : text.slice(-tailLength)}`,
    omittedChars,
    truncated: true,
  };
}

export function splitTextLines(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== '\r' && character !== '\n') {
      continue;
    }
    const end = character === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
    lines.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

export function withoutLineEnding(line: string): string {
  return line.replace(/(?:\r\n|\r|\n)$/u, '');
}

function isBinary(buffer: Uint8Array): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  const sampleLength = Math.min(buffer.length, 8_192);
  let controlCharacters = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index] ?? 0;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      controlCharacters += 1;
    }
  }
  return sampleLength > 0 && controlCharacters / sampleLength > 0.1;
}
