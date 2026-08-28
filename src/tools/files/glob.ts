import path from 'node:path';

import { FileToolError } from './errors.js';

export function matchesGlob(relativePath: string, pattern: string | undefined): boolean {
  validateGlob(pattern);
  if (pattern === undefined) {
    return true;
  }

  const normalizedPattern = pattern.replaceAll('\\', '/');
  let expression = '^';
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index] as string;
    const nextCharacter = normalizedPattern[index + 1];
    if (character === '*' && nextCharacter === '*') {
      if (normalizedPattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegularExpression(character);
    }
  }
  expression += '$';
  return new RegExp(expression, process.platform === 'win32' ? 'iu' : 'u').test(
    relativePath.replaceAll(path.sep, '/'),
  );
}

export function validateGlob(pattern: string | undefined): void {
  if (
    pattern !== undefined &&
    (pattern.length === 0 || pattern.length > 512 || pattern.includes('\0'))
  ) {
    throw new FileToolError(
      'invalid_tool_input',
      'INVALID_FILE_TOOL_INPUT',
      'Glob patterns must contain between 1 and 512 characters.',
    );
  }
}

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
