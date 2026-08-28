import { FileToolError } from './errors.js';

export function assertInputObject(input: unknown): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidInput('Tool input must be a JSON object.');
  }
}

export function requiredString(
  input: Readonly<Record<string, unknown>>,
  key: string,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): string {
  const value = input[key];
  if (typeof value !== 'string' || (options.allowEmpty !== true && value.length === 0)) {
    throw invalidInput(`Input field "${key}" must be a non-empty string.`);
  }
  return value;
}

export function optionalString(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidInput(`Input field "${key}" must be a string when provided.`);
  }
  return value;
}

export function optionalBoolean(
  input: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw invalidInput(`Input field "${key}" must be a boolean when provided.`);
  }
  return value;
}

export function optionalInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(
      `Input field "${key}" must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function assertOnlyKeys(
  input: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): void {
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) {
    throw invalidInput(`Unknown input field "${unknownKey}".`);
  }
}

export function invalidInput(message: string): FileToolError {
  return new FileToolError('invalid_tool_input', 'INVALID_FILE_TOOL_INPUT', message);
}
