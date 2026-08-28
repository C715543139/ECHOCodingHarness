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
      command: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 1 },
    },
    required: ['command'],
  },
  async execute(input, context) {
    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      return invalidInput('run_command requires a non-empty command string.');
    }
    if (
      input.timeoutMs !== undefined &&
      (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)
    ) {
      return invalidInput('timeoutMs must be a positive safe integer when provided.');
    }
    const timeoutMs = Math.min(
      input.timeoutMs ?? context.limits.timeoutMs,
      context.limits.timeoutMs,
    );
    return mapExecution(
      await executePowerShell({
        command: input.command,
        workspaceRoot: context.workspaceRoot,
        timeoutMs,
        maxOutputChars: context.limits.maxOutputChars,
        signal: context.signal,
      }),
    );
  },
};
