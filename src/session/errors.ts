import type { EchoError } from '../contracts/index.js';

export function storageError(code: string, message: string, cause?: unknown): EchoError {
  return {
    category: 'storage',
    code,
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  };
}

export function isStorageError(error: unknown): error is EchoError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'category' in error &&
    error.category === 'storage'
  );
}

export function configurationError(code: string, message: string, cause?: unknown): EchoError {
  return {
    category: 'configuration',
    code,
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  };
}
