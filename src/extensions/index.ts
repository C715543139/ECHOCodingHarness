export {
  parseExtensionCatalog,
  serializeExtensionCatalog,
  validateExtensionCatalog,
} from './catalog-validation.js';
export type { ExtensionContentSnapshot } from './content-hash.js';
export {
  ExtensionStorageError,
  ExtensionWorkerError,
  type ExtensionStorageErrorCode,
  type ExtensionWorkerErrorCode,
} from './errors.js';
export { validateToolInputSchema } from './json-schema.js';
export { EXTENSION_LIMITS } from './limits.js';
export {
  assertValidExtensionId,
  assertValidToolName,
  assertValidVersion,
  normalizeExtensionRelativePath,
  parseExtensionManifest,
} from './manifest.js';
export type { ExtensionWorkspacePaths } from './workspace-paths.js';
export {
  WorkspaceExtensionStore,
  type AtomicCatalogWriter,
  type WorkspaceExtensionStoreOptions,
} from './workspace-extension-store.js';
export { ExtensionRuntimeManager, type ExtensionRuntimeManagerOptions } from './runtime-manager.js';
export {
  ExtensionWorkerHost,
  type ExtensionWorkerFault,
  type ExtensionWorkerHostOptions,
  type ExtensionWorkerSpec,
} from './worker-host.js';
