import type { EchoError, ToolDefinition, ToolExecution } from '../../contracts/index.js';
import { executePowerShell, type PowerShellExecutionResult } from '../../execution/powershell.js';

export interface RunCommandInput {
  readonly command: string;
  readonly timeoutMs?: number;
}

export interface RunCommandData {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly stdoutOriginalChars: number;
  readonly stderrOriginalChars: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

type RunCommandValidation =
  Readonly<{ valid: true; input: RunCommandInput }> | Readonly<{ valid: false; message: string }>;

const RUN_COMMAND_KEYS = new Set(['command', 'timeoutMs']);

function validateInput(input: unknown): RunCommandValidation {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { valid: false, message: 'run_command input must be an object.' };
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return { valid: false, message: 'run_command input must be a plain object.' };
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.some((key) => typeof key !== 'string' || !RUN_COMMAND_KEYS.has(key)) ||
      !Object.hasOwn(input, 'command')
    ) {
      return {
        valid: false,
        message: 'run_command accepts only command and optional timeoutMs fields.',
      };
    }

    const commandProperty = Object.getOwnPropertyDescriptor(input, 'command');
    if (
      commandProperty === undefined ||
      !('value' in commandProperty) ||
      typeof commandProperty.value !== 'string' ||
      commandProperty.value.trim().length === 0 ||
      commandProperty.value.includes('\0')
    ) {
      return { valid: false, message: 'run_command requires a non-empty command string.' };
    }

    if (!Object.hasOwn(input, 'timeoutMs')) {
      return { valid: true, input: { command: commandProperty.value } };
    }
    const timeoutProperty = Object.getOwnPropertyDescriptor(input, 'timeoutMs');
    if (
      timeoutProperty === undefined ||
      !('value' in timeoutProperty) ||
      !Number.isSafeInteger(timeoutProperty.value) ||
      (timeoutProperty.value as number) < 1
    ) {
      return { valid: false, message: 'timeoutMs must be a positive safe integer when provided.' };
    }
    return {
      valid: true,
      input: { command: commandProperty.value, timeoutMs: timeoutProperty.value as number },
    };
  } catch {
    return { valid: false, message: 'run_command input could not be safely inspected.' };
  }
}

function failed(error: EchoError, truncated = false): ToolExecution<RunCommandData> {
  return {
    status: 'failed',
    summary: error.message,
    error,
    truncated,
  };
}

function invalidInput(message: string): ToolExecution<RunCommandData> {
  return failed({
    category: 'invalid_tool_input',
    code: 'INVALID_COMMAND',
    message,
    retryable: false,
  });
}

function failureDetails(
  result: PowerShellExecutionResult,
): Readonly<Record<string, string | number | boolean | null>> {
  return {
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stderrOriginalChars: result.stderrOriginalChars,
    stderrTruncated: result.stderrTruncated,
    stdout: result.stdout,
    stdoutOriginalChars: result.stdoutOriginalChars,
    stdoutTruncated: result.stdoutTruncated,
    terminationAttempted: result.terminationAttempted,
    terminationSucceeded: result.terminationSucceeded,
  };
}

function mapExecution(result: PowerShellExecutionResult): ToolExecution<RunCommandData> {
  const truncated = result.stdoutTruncated || result.stderrTruncated;
  if (result.reason === 'timeout') {
    return failed(
      {
        category: 'tool_timeout',
        code: 'COMMAND_TIMEOUT',
        message: `Command timed out after ${result.durationMs} ms.`,
        retryable: false,
        details: failureDetails(result),
      },
      truncated,
    );
  }
  if (result.reason === 'cancelled') {
    return failed(
      {
        category: 'cancelled',
        code: 'COMMAND_CANCELLED',
        message: 'Command execution was cancelled.',
        retryable: false,
        details: failureDetails(result),
      },
      truncated,
    );
  }
  if (result.reason === 'spawn_error' || result.exitCode === null) {
    return failed(
      {
        category: 'tool_execution',
        code: 'COMMAND_START_FAILED',
        message: 'PowerShell could not be started in the configured workspace.',
        retryable: false,
        details: failureDetails(result),
        cause: result.errorMessage,
      },
      truncated,
    );
  }

  return {
    status: 'completed',
    summary:
      result.exitCode === 0
        ? `Command completed in ${result.durationMs} ms.`
        : `Command exited with code ${result.exitCode} after ${result.durationMs} ms.`,
    data: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      stdoutOriginalChars: result.stdoutOriginalChars,
      stderrOriginalChars: result.stderrOriginalChars,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    },
    truncated,
  };
}

export const runCommandTool: ToolDefinition<RunCommandInput, RunCommandData> = {
  name: 'run_command',
  description:
    'Run one PowerShell command in the fixed workspace and return bounded stdout, stderr, exit code, and duration.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: { type: 'string', minLength: 1, pattern: '^(?=[\\s\\S]*\\S)[^\\u0000]*$' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    },
    required: ['command'],
  },
  async execute(input, context) {
    const validation = validateInput(input);
    if (!validation.valid) return invalidInput(validation.message);
    const validInput = validation.input;
    const timeoutMs = Math.min(
      validInput.timeoutMs ?? context.limits.timeoutMs,
      context.limits.timeoutMs,
    );
    return mapExecution(
      await executePowerShell({
        command: validInput.command,
        workspaceRoot: context.workspaceRoot,
        timeoutMs,
        maxOutputChars: context.limits.maxOutputChars,
        signal: context.signal,
      }),
    );
  },
};
