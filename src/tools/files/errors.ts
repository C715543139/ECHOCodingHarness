import type { EchoErrorCategory, ToolExecution } from '../../contracts/index.js';

export class FileToolError extends Error {
  readonly category: EchoErrorCategory;
  readonly code: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>> | undefined;

  constructor(
    category: EchoErrorCategory,
    code: string,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'FileToolError';
    this.category = category;
    this.code = code;
    this.details = details;
  }
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FileToolError(
      'cancelled',
      'FILE_TOOL_CANCELLED',
      'The file operation was cancelled before it completed.',
    );
  }
}

export function failedExecution<T>(error: unknown, operation: string): ToolExecution<T> {
  if (error instanceof FileToolError) {
    return {
      status: 'failed',
      summary: `${operation} failed: ${error.message}`,
      error: {
        category: error.category,
        code: error.code,
        message: error.message,
        retryable: false,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      truncated: false,
    };
  }

  if (isAbortError(error)) {
    return failedExecution<T>(
      new FileToolError(
        'cancelled',
        'FILE_TOOL_CANCELLED',
        'The file operation was cancelled before it completed.',
      ),
      operation,
    );
  }

  return {
    status: 'failed',
    summary: `${operation} failed because the filesystem operation did not complete.`,
    error: {
      category: 'tool_execution',
      code: 'FILE_OPERATION_FAILED',
      message:
        'The filesystem operation did not complete. Check the relative path and permissions.',
      retryable: false,
      cause: error,
    },
    truncated: false,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
