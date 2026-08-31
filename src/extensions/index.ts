export {
  parseExtensionCatalog,
  serializeExtensionCatalog,
  validateExtensionCatalog,
} from './catalog-validation.js';
export { snapshotExtensionContent, type ExtensionContentSnapshot } from './content-hash.js';
export { ExtensionStorageError, type ExtensionStorageErrorCode } from './errors.js';
export { validateToolInputSchema } from './json-schema.js';
export { EXTENSION_LIMITS } from './limits.js';
export {
  assertValidExtensionId,
  assertValidToolName,
  assertValidVersion,
  normalizeExtensionRelativePath,
  parseExtensionManifest,
} from './manifest.js';
export {
  assertOwnedExtensionDirectory,
  ensureExtensionWorkspacePaths,
  installedExtensionPath,
  stagingExtensionPath,
  type ExtensionWorkspacePaths,
} from './workspace-paths.js';
export {
  WorkspaceExtensionStore,
  type AtomicCatalogWriter,
  type WorkspaceExtensionStoreOptions,
} from './workspace-extension-store.js';
