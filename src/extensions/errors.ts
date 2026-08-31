export type ExtensionStorageErrorCode =
  | 'WORKSPACE_INVALID'
  | 'WORKSPACE_CHANGED'
  | 'LINK_DENIED'
  | 'PATH_OUTSIDE_EXTENSION_ROOT'
  | 'MANIFEST_READ_FAILED'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_PATH_INVALID'
  | 'TOOL_SCHEMA_INVALID'
  | 'TOOL_NAME_CONFLICT'
  | 'EXTENSION_CONTENT_INVALID'
  | 'CATALOG_READ_FAILED'
  | 'CATALOG_CORRUPT'
  | 'CATALOG_VERSION_UNSUPPORTED'
  | 'CATALOG_INTEGRITY_FAILED'
  | 'CATALOG_RECOVERY_UNCERTAIN'
  | 'CATALOG_REVISION_CONFLICT'
  | 'CATALOG_WRITE_FAILED';

export class ExtensionStorageError extends Error {
  readonly code: ExtensionStorageErrorCode;

  constructor(code: ExtensionStorageErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExtensionStorageError';
    this.code = code;
  }
}

export type ExtensionWorkerErrorCode =
  | 'WORKER_INITIALIZATION_FAILED'
  | 'WORKER_PROTOCOL_ERROR'
  | 'WORKER_CRASHED'
  | 'WORKER_TIMEOUT'
  | 'WORKER_CLOSED'
  | 'EXTENSION_BUSY'
  | 'REGISTRY_CONFLICT';

export class ExtensionWorkerError extends Error {
  readonly code: ExtensionWorkerErrorCode;

  constructor(code: ExtensionWorkerErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExtensionWorkerError';
    this.code = code;
  }
}

export function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
