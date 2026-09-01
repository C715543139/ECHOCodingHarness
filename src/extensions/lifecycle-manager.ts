import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ExtensionCatalog,
  ExtensionCatalogEntry,
  ExtensionManifest,
} from '../contracts/index.js';
import type { ToolRegistry } from '../tools/index.js';

import { createExtensionAuthoringTemplate } from './authoring-template.js';
import { snapshotExtensionContent, type ExtensionContentSnapshot } from './content-hash.js';
import {
  ExtensionLifecycleError,
  ExtensionStorageError,
  ExtensionWorkerError,
  isFileSystemError,
} from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import { assertValidExtensionId, assertValidToolName } from './manifest.js';
import { ExtensionRuntimeManager } from './runtime-manager.js';
import {
  WorkspaceExtensionStore,
  type WorkspaceExtensionStoreOptions,
} from './workspace-extension-store.js';
import { ExtensionWorkerHost, type ExtensionWorkerFault } from './worker-host.js';

const SELF_TEST_TIMEOUT_MS = 15_000;
const SELF_TEST_OUTPUT_CHARS = 16_384;
const CHECK_DETAIL_CHARS = 1_024;

export interface ExtensionCheckItem {
  readonly name: 'content' | 'names' | 'worker' | 'self-test';
  readonly passed: boolean;
  readonly detail: string;
}

export interface ExtensionCheckReport {
  readonly extensionId: string;
  readonly status: 'passed' | 'failed';
  readonly contentHash?: string;
  readonly tools: readonly string[];
  readonly passedChecks: number;
  readonly failedChecks: number;
  readonly checks: readonly ExtensionCheckItem[];
  readonly warnings: readonly string[];
}

export interface ExtensionListItem {
  readonly id: string;
  readonly version: string;
  readonly contentHash: string;
  readonly state: ExtensionCatalogEntry['state'];
  readonly tools: readonly string[];
  readonly loaded: boolean;
  readonly quarantineReason?: string;
  readonly cleanupPending: boolean;
}

export interface ExtensionMutationResult {
  readonly extensionId: string;
  readonly state: ExtensionCatalogEntry['state'] | 'absent';
  readonly changed: boolean;
  readonly loaded: boolean;
  readonly cleanupPending: boolean;
  readonly contentHash?: string;
  readonly deactivated?: boolean;
}

interface SelfTestResult {
  readonly passed: boolean;
  readonly detail: string;
  readonly warning?: string;
}

interface MaterializedExtension {
  readonly root: string;
  readonly created: boolean;
}

export interface ExtensionLifecycleManagerOptions {
  readonly workspaceRoot: string;
  readonly registry: ToolRegistry;
  /** Controls process-local loading without changing the persisted enabled state. */
  readonly runtimeAllowed?: () => boolean;
  readonly now?: () => Date;
  readonly removeTree?: (target: string) => Promise<void>;
  readonly storeOptions?: WorkspaceExtensionStoreOptions;
}

function bounded(value: string, maximum = CHECK_DETAIL_CHARS): string {
  const normalized = value.replaceAll(/\s+/gu, ' ').trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function cleanEntry(
  entry: ExtensionCatalogEntry,
  state: ExtensionCatalogEntry['state'],
  extra: { readonly quarantineReason?: string; readonly cleanupPending?: boolean } = {},
): ExtensionCatalogEntry {
  return {
    id: entry.id,
    version: entry.version,
    contentHash: entry.contentHash,
    state,
    tools: entry.tools,
    installedAt: entry.installedAt,
    ...(extra.quarantineReason === undefined
      ? {}
      : {
          quarantineReason: bounded(
            extra.quarantineReason,
            EXTENSION_LIMITS.quarantineReasonLength,
          ),
        }),
    ...(extra.cleanupPending === undefined ? {} : { cleanupPending: extra.cleanupPending }),
  };
}

function replaceEntry(
  catalog: ExtensionCatalog,
  entry: ExtensionCatalogEntry,
): readonly ExtensionCatalogEntry[] {
  return [...catalog.extensions.filter((candidate) => candidate.id !== entry.id), entry];
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'PATH',
    'PATHEXT',
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_ENV',
  ]) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return false;
    throw error;
  }
}

const UUID_FILE_SUFFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isOwnedTrashEntry(name: string, extensionId: string): boolean {
  const prefix = `${extensionId}-`;
  return name.startsWith(prefix) && UUID_FILE_SUFFIX.test(name.slice(prefix.length));
}

async function runSelfTest(
  extensionRoot: string,
  manifest: ExtensionManifest,
  signal: AbortSignal,
): Promise<SelfTestResult> {
  const selfTestPath = path.join(extensionRoot, ...manifest.selfTest.split('/'));
  return new Promise((resolve) => {
    let output = '';
    let overflow = false;
    let settled = false;
    const child = spawn(process.execPath, [selfTestPath], {
      cwd: extensionRoot,
      env: sanitizedEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (result: SelfTestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => {
      child.kill();
      finish({ passed: false, detail: 'Self-test was cancelled.' });
    };
    const append = (chunk: Buffer | string): void => {
      if (overflow) return;
      output += chunk.toString();
      if (output.length > SELF_TEST_OUTPUT_CHARS) {
        overflow = true;
        child.kill();
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => {
      finish({
        passed: false,
        detail: bounded(error instanceof Error ? error.message : 'Self-test process failed.'),
      });
    });
    child.once('close', (code, terminationSignal) => {
      if (overflow) {
        finish({ passed: false, detail: 'Self-test output exceeded the bounded limit.' });
        return;
      }
      const detail = bounded(output);
      if (code === 0) {
        finish({
          passed: true,
          detail: 'Self-test exited successfully.',
          ...(detail.length === 0 ? {} : { warning: detail }),
        });
        return;
      }
      finish({
        passed: false,
        detail:
          detail.length > 0
            ? `Self-test failed: ${detail}`
            : `Self-test failed with ${terminationSignal ?? `exit code ${String(code)}`}.`,
      });
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ passed: false, detail: 'Self-test exceeded the 15 second timeout.' });
    }, SELF_TEST_TIMEOUT_MS);
    timer.unref();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export class ExtensionLifecycleManager {
  readonly store: WorkspaceExtensionStore;
  readonly runtime: ExtensionRuntimeManager;
  private readonly now: () => Date;
  private readonly removeTree: (target: string) => Promise<void>;
  private readonly runtimeAllowed: () => boolean;
  private readonly loading = new Set<string>();
  private serialTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly workspaceRoot: string,
    store: WorkspaceExtensionStore,
    runtime: ExtensionRuntimeManager,
    options: ExtensionLifecycleManagerOptions,
  ) {
    this.store = store;
    this.runtime = runtime;
    this.now = options.now ?? (() => new Date());
    this.runtimeAllowed = options.runtimeAllowed ?? (() => true);
    this.removeTree =
      options.removeTree ?? (async (target) => fs.rm(target, { recursive: true, force: true }));
  }

  static async open(options: ExtensionLifecycleManagerOptions): Promise<ExtensionLifecycleManager> {
    const store = await WorkspaceExtensionStore.open(options.workspaceRoot, {
      ...options.storeOptions,
      reservedToolNames: [
        'extension_init',
        'extension_check',
        'extension_install',
        'extension_list',
        'extension_enable',
        'extension_disable',
        'extension_uninstall',
        ...(options.storeOptions?.reservedToolNames ?? []),
      ],
    });
    const paths = await store.ensureWorkspace();
    const holder: { current: ExtensionLifecycleManager | undefined } = { current: undefined };
    const runtime = new ExtensionRuntimeManager({
      registry: options.registry,
      workspaceRoot: paths.workspaceRoot,
      onQuarantine: (fault) => holder.current?.workerFault(fault),
    });
    const manager = new ExtensionLifecycleManager(paths.workspaceRoot, store, runtime, options);
    holder.current = manager;
    return manager;
  }

  async init(
    extensionId: string,
    toolNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<ExtensionMutationResult> {
    return this.exclusive(async () => {
      this.assertNotAborted(signal);
      assertValidExtensionId(extensionId, 'extensionId');
      if (toolNames.length === 0 || toolNames.length > EXTENSION_LIMITS.toolCount) {
        throw new ExtensionStorageError(
          'MANIFEST_INVALID',
          `toolNames must contain between 1 and ${String(EXTENSION_LIMITS.toolCount)} names.`,
        );
      }
      for (const [index, toolName] of toolNames.entries()) {
        assertValidToolName(toolName, `toolNames[${String(index)}]`);
      }
      if (new Set(toolNames).size !== toolNames.length) {
        throw new ExtensionStorageError('TOOL_NAME_CONFLICT', 'toolNames must be unique.');
      }
      const catalog = await this.store.readCatalog();
      const template = createExtensionAuthoringTemplate(extensionId, toolNames);
      this.store.assertToolNamesAvailable(template.manifest, catalog, extensionId);
      const paths = await this.store.ensureWorkspace();
      const target = await this.store.stagingExtensionPath(extensionId);
      if (await pathExists(target)) {
        throw new ExtensionLifecycleError(
          'ALREADY_EXISTS',
          `Staging extension "${extensionId}" already exists and was not overwritten.`,
        );
      }
      const temporary = path.join(paths.stagingRoot, `.init-${extensionId}-${randomUUID()}.tmp`);
      try {
        await fs.mkdir(temporary);
        for (const [relativePath, contents] of Object.entries(template.files)) {
          await fs.writeFile(path.join(temporary, relativePath), contents, {
            encoding: 'utf8',
            flag: 'wx',
          });
        }
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        if (isFileSystemError(error, 'EEXIST')) {
          throw new ExtensionLifecycleError(
            'ALREADY_EXISTS',
            `Staging extension "${extensionId}" already exists and was not overwritten.`,
          );
        }
        throw error;
      }
      return {
        extensionId,
        state: 'absent',
        changed: true,
        loaded: false,
        cleanupPending: false,
      };
    });
  }

  async check(extensionId: string, signal: AbortSignal): Promise<ExtensionCheckReport> {
    return this.exclusive(() => this.checkUnlocked(extensionId, signal));
  }

  async install(extensionId: string, signal: AbortSignal): Promise<ExtensionMutationResult> {
    return this.exclusive(async () => {
      const report = await this.checkUnlocked(extensionId, signal);
      if (report.status !== 'passed') {
        throw new ExtensionLifecycleError(
          'EXTENSION_CHECK_FAILED',
          `Extension "${extensionId}" did not pass pre-install checks.`,
        );
      }
      this.assertNotAborted(signal);
      const source = await this.store.stagingExtensionPath(extensionId);
      const snapshot = await this.store.snapshotStagedExtension(extensionId);
      if (snapshot.contentHash !== report.contentHash) {
        throw new ExtensionStorageError(
          'EXTENSION_CONTENT_INVALID',
          'Staging content changed after extension_check.',
        );
      }
      const catalog = await this.store.readCatalog();
      this.store.assertToolNamesAvailable(snapshot.manifest, catalog, extensionId);
      const existing = catalog.extensions.find((entry) => entry.id === extensionId);
      if (
        existing?.contentHash === snapshot.contentHash &&
        existing.state === 'enabled' &&
        existing.cleanupPending !== true &&
        (this.runtime.isLoaded(extensionId) || !this.runtimeAllowed())
      ) {
        return this.mutation(existing, false);
      }
      if (this.runtime.activeCallCount(extensionId) > 0) this.busy(extensionId);

      const installed = await this.materializeInstalled(source, snapshot);
      try {
        await this.probe(installed.root, snapshot.manifest);
      } catch (error) {
        await this.discardMaterialized(installed);
        throw new ExtensionLifecycleError(
          'EXTENSION_INSTALL_FAILED',
          `Extension "${extensionId}" failed its installed Worker handshake.`,
          error,
        );
      }
      const wasLoaded = this.runtime.isLoaded(extensionId);
      if (wasLoaded) await this.runtime.unload(extensionId);
      if (this.runtimeAllowed()) {
        try {
          await this.loadRuntime(installed.root, snapshot.manifest);
        } catch (error) {
          await this.discardMaterialized(installed);
          await this.restoreRuntime(existing).catch(() => undefined);
          throw new ExtensionLifecycleError(
            'EXTENSION_INSTALL_FAILED',
            `Extension "${extensionId}" could not be loaded.`,
            error,
          );
        }
      }

      const cleanupNeeded =
        existing !== undefined &&
        (existing.contentHash !== snapshot.contentHash || existing.cleanupPending === true);
      const entry: ExtensionCatalogEntry = {
        id: snapshot.manifest.id,
        version: snapshot.manifest.version,
        contentHash: snapshot.contentHash,
        state: 'enabled',
        tools: snapshot.manifest.tools.map((tool) => tool.name),
        installedAt:
          existing?.contentHash === snapshot.contentHash
            ? existing.installedAt
            : this.now().toISOString(),
        ...(cleanupNeeded ? { cleanupPending: true } : {}),
      };
      try {
        await this.store.replaceCatalog(catalog.revision, replaceEntry(catalog, entry));
      } catch (error) {
        await this.runtime.unload(extensionId).catch(() => undefined);
        await this.discardMaterialized(installed);
        await this.restoreRuntime(existing).catch(() => undefined);
        throw error;
      }
      if (this.runtimeAllowed() && !this.runtime.isLoaded(extensionId)) {
        await this.persistQuarantine(extensionId, 'Worker closed during installation.');
        throw new ExtensionLifecycleError(
          'EXTENSION_INSTALL_FAILED',
          `Extension "${extensionId}" worker closed during installation.`,
        );
      }
      if (!cleanupNeeded) return this.mutation(entry, true);

      const cleanupComplete = await this.cleanupSupersededExtensionArtifacts(
        extensionId,
        snapshot.contentHash,
      );
      if (!cleanupComplete) return this.mutation(entry, true);

      const cleanedEntry: ExtensionCatalogEntry = { ...entry, cleanupPending: false };
      try {
        await this.store.replaceCatalog(catalog.revision + 1, replaceEntry(catalog, cleanedEntry));
        return this.mutation(cleanedEntry, true);
      } catch {
        // The installed version is usable and the persisted flag remains conservatively true.
        return this.mutation(entry, true);
      }
    });
  }

  async list(signal?: AbortSignal): Promise<readonly ExtensionListItem[]> {
    return this.exclusive(async () => {
      this.assertNotAborted(signal);
      const catalog = await this.store.readCatalog();
      return catalog.extensions.map((entry) => ({
        id: entry.id,
        version: entry.version,
        contentHash: entry.contentHash,
        state: entry.state,
        tools: entry.tools,
        loaded: this.runtime.isLoaded(entry.id),
        ...(entry.quarantineReason === undefined
          ? {}
          : { quarantineReason: entry.quarantineReason }),
        cleanupPending: entry.cleanupPending ?? false,
      }));
    });
  }

  async enable(extensionId: string, signal?: AbortSignal): Promise<ExtensionMutationResult> {
    return this.exclusive(async () => {
      this.assertNotAborted(signal);
      assertValidExtensionId(extensionId, 'extensionId');
      const catalog = await this.store.readCatalog();
      const entry = this.requireEntry(catalog, extensionId);
      if (
        entry.state === 'enabled' &&
        (this.runtime.isLoaded(extensionId) || !this.runtimeAllowed())
      ) {
        return this.mutation(entry, false);
      }
      if (this.runtime.activeCallCount(extensionId) > 0) this.busy(extensionId);
      const snapshot = await this.store.snapshotInstalledExtension(entry);
      this.store.assertToolNamesAvailable(snapshot.manifest, catalog, extensionId);
      if (this.runtime.isLoaded(extensionId)) await this.runtime.unload(extensionId);
      try {
        await this.probe(
          await this.store.installedExtensionPath(entry.id, entry.contentHash),
          snapshot.manifest,
        );
        if (this.runtimeAllowed()) {
          await this.loadRuntime(
            await this.store.installedExtensionPath(entry.id, entry.contentHash),
            snapshot.manifest,
          );
        }
      } catch (error) {
        await this.persistQuarantine(
          extensionId,
          error instanceof Error ? error.message : 'Worker initialization failed.',
        );
        throw new ExtensionLifecycleError(
          'EXTENSION_INSTALL_FAILED',
          `Extension "${extensionId}" could not be enabled and was quarantined.`,
          error,
        );
      }
      const enabled = cleanEntry(entry, 'enabled');
      try {
        await this.store.replaceCatalog(catalog.revision, replaceEntry(catalog, enabled));
      } catch (error) {
        await this.runtime.unload(extensionId).catch(() => undefined);
        throw error;
      }
      return this.mutation(enabled, true);
    });
  }

  async disable(extensionId: string, signal?: AbortSignal): Promise<ExtensionMutationResult> {
    return this.exclusive(async () => {
      this.assertNotAborted(signal);
      assertValidExtensionId(extensionId, 'extensionId');
      const catalog = await this.store.readCatalog();
      const entry = this.requireEntry(catalog, extensionId);
      if (this.runtime.activeCallCount(extensionId) > 0) this.busy(extensionId);
      if (entry.state === 'disabled' && !this.runtime.isLoaded(extensionId)) {
        return this.mutation(entry, false);
      }
      if (this.runtime.isLoaded(extensionId)) await this.runtime.unload(extensionId);
      const disabled = cleanEntry(entry, 'disabled', {
        ...(entry.cleanupPending === undefined ? {} : { cleanupPending: entry.cleanupPending }),
      });
      try {
        await this.store.replaceCatalog(catalog.revision, replaceEntry(catalog, disabled));
      } catch (error) {
        if (entry.state === 'enabled') await this.restoreRuntime(entry).catch(() => undefined);
        throw error;
      }
      return this.mutation(disabled, true);
    });
  }

  async uninstall(extensionId: string, signal?: AbortSignal): Promise<ExtensionMutationResult> {
    return this.exclusive(async () => {
      this.assertNotAborted(signal);
      assertValidExtensionId(extensionId, 'extensionId');
      const catalog = await this.store.readCatalog();
      const entry = catalog.extensions.find((candidate) => candidate.id === extensionId);
      if (this.runtime.activeCallCount(extensionId) > 0) this.busy(extensionId);
      if (this.runtime.isLoaded(extensionId)) await this.runtime.unload(extensionId);
      if (entry !== undefined) {
        await this.store.replaceCatalog(
          catalog.revision,
          catalog.extensions.filter((candidate) => candidate.id !== extensionId),
        );
      }
      const cleanupPending = !(await this.cleanupExtensionArtifacts(extensionId));
      return {
        extensionId,
        state: 'absent',
        changed: entry !== undefined || cleanupPending,
        loaded: false,
        cleanupPending,
        deactivated: true,
        ...(entry === undefined ? {} : { contentHash: entry.contentHash }),
      };
    });
  }

  async close(): Promise<void> {
    await this.runtime.shutdownAll();
  }

  /**
   * Reconciles persisted enabled entries with the process-local registry.
   * A broken entry is quarantined by enable() without preventing healthy peers from loading.
   */
  async activateEnabled(signal?: AbortSignal): Promise<void> {
    if (!this.runtimeAllowed()) return;
    const entries = await this.list(signal);
    for (const entry of entries) {
      if (entry.state !== 'enabled' || entry.loaded) continue;
      try {
        await this.enable(entry.id, signal);
      } catch (error) {
        if (error instanceof ExtensionLifecycleError && error.code === 'EXTENSION_INSTALL_FAILED') {
          continue;
        }
        throw error;
      }
    }
  }

  /** Unloads Workers and tools while preserving Catalog state and installed files. */
  async deactivateRuntime(): Promise<void> {
    await this.runtime.shutdownAll();
  }

  private async checkUnlocked(
    extensionId: string,
    signal: AbortSignal,
  ): Promise<ExtensionCheckReport> {
    assertValidExtensionId(extensionId, 'extensionId');
    this.assertNotAborted(signal);
    const checks: ExtensionCheckItem[] = [];
    const warnings: string[] = [];
    let snapshot: ExtensionContentSnapshot;
    try {
      snapshot = await this.store.snapshotStagedExtension(extensionId);
      checks.push({
        name: 'content',
        passed: true,
        detail: `Manifest and ${String(snapshot.files.length)} regular files hashed successfully.`,
      });
    } catch (error) {
      checks.push({
        name: 'content',
        passed: false,
        detail: bounded(error instanceof Error ? error.message : 'Extension content is invalid.'),
      });
      return this.report(extensionId, undefined, checks, warnings);
    }
    try {
      const catalog = await this.store.readCatalog();
      this.store.assertToolNamesAvailable(snapshot.manifest, catalog, extensionId);
      checks.push({ name: 'names', passed: true, detail: 'Tool names are unique and available.' });
    } catch (error) {
      checks.push({
        name: 'names',
        passed: false,
        detail: bounded(error instanceof Error ? error.message : 'Tool names conflict.'),
      });
    }
    this.assertNotAborted(signal);
    const root = await this.store.stagingExtensionPath(extensionId);
    try {
      await this.probe(root, snapshot.manifest);
      checks.push({
        name: 'worker',
        passed: true,
        detail: 'Worker initialized and handlers match the Manifest.',
      });
    } catch (error) {
      checks.push({
        name: 'worker',
        passed: false,
        detail: bounded(error instanceof Error ? error.message : 'Worker initialization failed.'),
      });
    }
    this.assertNotAborted(signal);
    try {
      const selfTest = await runSelfTest(root, snapshot.manifest, signal);
      checks.push({ name: 'self-test', passed: selfTest.passed, detail: selfTest.detail });
      if (selfTest.warning !== undefined) warnings.push(selfTest.warning);
    } catch (error) {
      checks.push({
        name: 'self-test',
        passed: false,
        detail: bounded(error instanceof Error ? error.message : 'Self-test could not run.'),
      });
    }
    return this.report(extensionId, snapshot, checks, warnings);
  }

  private report(
    extensionId: string,
    snapshot: ExtensionContentSnapshot | undefined,
    checks: readonly ExtensionCheckItem[],
    warnings: readonly string[],
  ): ExtensionCheckReport {
    const failedChecks = checks.filter((check) => !check.passed).length;
    return {
      extensionId,
      status: failedChecks === 0 ? 'passed' : 'failed',
      ...(snapshot === undefined ? {} : { contentHash: snapshot.contentHash }),
      tools: snapshot?.manifest.tools.map((tool) => tool.name) ?? [],
      passedChecks: checks.length - failedChecks,
      failedChecks,
      checks,
      warnings: warnings.slice(0, 8).map((warning) => bounded(warning, 512)),
    };
  }

  private async probe(extensionRoot: string, manifest: ExtensionManifest): Promise<void> {
    const host = await ExtensionWorkerHost.open({
      extensionId: manifest.id,
      extensionRoot,
      workspaceRoot: this.workspaceRoot,
      manifest,
    });
    await host.shutdown();
  }

  private async materializeInstalled(
    source: string,
    snapshot: ExtensionContentSnapshot,
  ): Promise<MaterializedExtension> {
    const paths = await this.store.ensureWorkspace();
    const target = await this.store.installedExtensionPath(
      snapshot.manifest.id,
      snapshot.contentHash,
    );
    if (await pathExists(target)) {
      const installed = await snapshotExtensionContent(
        target,
        paths.extensionsRoot,
        snapshot.manifest.id,
      );
      if (installed.contentHash !== snapshot.contentHash) {
        throw new ExtensionStorageError(
          'CATALOG_INTEGRITY_FAILED',
          'Existing installed content does not match its content hash.',
        );
      }
      return { root: target, created: false };
    }
    const temporary = path.join(
      paths.trashRoot,
      `.install-${snapshot.manifest.id}-${randomUUID()}.tmp`,
    );
    try {
      await fs.mkdir(temporary);
      for (const relativePath of snapshot.files) {
        const sourceFile = path.join(source, ...relativePath.split('/'));
        const targetFile = path.join(temporary, ...relativePath.split('/'));
        const stats = await fs.lstat(sourceFile);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new ExtensionStorageError(
            'LINK_DENIED',
            `Extension content "${relativePath}" changed into a link or non-file.`,
          );
        }
        await fs.mkdir(path.dirname(targetFile), { recursive: true });
        await fs.copyFile(sourceFile, targetFile);
      }
      const copied = await snapshotExtensionContent(
        temporary,
        paths.trashRoot,
        snapshot.manifest.id,
      );
      if (copied.contentHash !== snapshot.contentHash) {
        throw new ExtensionStorageError(
          'EXTENSION_CONTENT_INVALID',
          'Staging content changed while it was copied for installation.',
        );
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(temporary, target);
      return { root: target, created: true };
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (isFileSystemError(error, 'EEXIST') && (await pathExists(target))) {
        const installed = await snapshotExtensionContent(
          target,
          paths.extensionsRoot,
          snapshot.manifest.id,
        );
        if (installed.contentHash === snapshot.contentHash) {
          return { root: target, created: false };
        }
      }
      throw error;
    }
  }

  private async discardMaterialized(installed: MaterializedExtension): Promise<void> {
    if (!installed.created) return;
    await fs.rm(installed.root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rmdir(path.dirname(installed.root)).catch(() => undefined);
  }

  private async loadRuntime(extensionRoot: string, manifest: ExtensionManifest): Promise<void> {
    this.loading.add(manifest.id);
    try {
      await this.runtime.load(extensionRoot, manifest);
    } finally {
      this.loading.delete(manifest.id);
    }
  }

  private async restoreRuntime(entry: ExtensionCatalogEntry | undefined): Promise<void> {
    if (
      !this.runtimeAllowed() ||
      entry === undefined ||
      entry.state !== 'enabled' ||
      this.runtime.isLoaded(entry.id)
    )
      return;
    const snapshot = await this.store.snapshotInstalledExtension(entry);
    await this.loadRuntime(
      await this.store.installedExtensionPath(entry.id, entry.contentHash),
      snapshot.manifest,
    );
  }

  private workerFault(fault: ExtensionWorkerFault): void {
    if (this.loading.has(fault.extensionId)) return;
    void this.exclusive(() => this.persistQuarantine(fault.extensionId, fault.message)).catch(
      () => undefined,
    );
  }

  private async persistQuarantine(extensionId: string, reason: string): Promise<void> {
    const catalog = await this.store.readCatalog();
    const entry = catalog.extensions.find((candidate) => candidate.id === extensionId);
    if (entry === undefined) return;
    const quarantined = cleanEntry(entry, 'quarantined', { quarantineReason: reason });
    await this.store.replaceCatalog(catalog.revision, replaceEntry(catalog, quarantined));
  }

  private requireEntry(catalog: ExtensionCatalog, extensionId: string): ExtensionCatalogEntry {
    const entry = catalog.extensions.find((candidate) => candidate.id === extensionId);
    if (entry === undefined) {
      throw new ExtensionLifecycleError(
        'EXTENSION_NOT_FOUND',
        `Extension "${extensionId}" is not installed in this workspace.`,
      );
    }
    return entry;
  }

  private mutation(entry: ExtensionCatalogEntry, changed: boolean): ExtensionMutationResult {
    return {
      extensionId: entry.id,
      state: entry.state,
      changed,
      loaded: this.runtime.isLoaded(entry.id),
      cleanupPending: entry.cleanupPending ?? false,
      contentHash: entry.contentHash,
    };
  }

  private busy(extensionId: string): never {
    throw new ExtensionLifecycleError(
      'EXTENSION_BUSY',
      `Extension "${extensionId}" has active calls and cannot change lifecycle state.`,
    );
  }

  private assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new ExtensionLifecycleError(
        'EXTENSION_OPERATION_CANCELLED',
        'Extension operation was cancelled.',
      );
    }
  }

  private async cleanupExtensionArtifacts(extensionId: string): Promise<boolean> {
    const paths = await this.store.ensureWorkspace();
    const candidates = [
      await this.store.stagingExtensionPath(extensionId),
      path.join(paths.extensionsRoot, extensionId),
    ];
    const trashChildren = await fs.readdir(paths.trashRoot, { withFileTypes: true });
    for (const child of trashChildren) {
      if (isOwnedTrashEntry(child.name, extensionId))
        candidates.push(path.join(paths.trashRoot, child.name));
    }
    let complete = true;
    for (const candidate of candidates) {
      if (!(await pathExists(candidate))) continue;
      let cleanupTarget = candidate;
      if (path.dirname(candidate) !== paths.trashRoot) {
        cleanupTarget = path.join(paths.trashRoot, `${extensionId}-${randomUUID()}`);
        try {
          await fs.rename(candidate, cleanupTarget);
        } catch {
          complete = false;
          continue;
        }
      }
      try {
        await this.removeTree(cleanupTarget);
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private async cleanupSupersededExtensionArtifacts(
    extensionId: string,
    currentContentHash: string,
  ): Promise<boolean> {
    const paths = await this.store.ensureWorkspace();
    const currentRoot = await this.store.installedExtensionPath(extensionId, currentContentHash);
    const extensionRoot = path.dirname(currentRoot);
    const candidates: string[] = [];
    if (await pathExists(extensionRoot)) {
      const children = await fs.readdir(extensionRoot, { withFileTypes: true });
      for (const child of children) {
        const candidate = path.join(extensionRoot, child.name);
        if (candidate === currentRoot) continue;
        if (!child.isDirectory() || !/^[a-f0-9]{64}$/u.test(child.name)) return false;
        candidates.push(candidate);
      }
    }
    const trashChildren = await fs.readdir(paths.trashRoot, { withFileTypes: true });
    for (const child of trashChildren) {
      if (isOwnedTrashEntry(child.name, extensionId)) {
        candidates.push(path.join(paths.trashRoot, child.name));
      }
    }

    let complete = true;
    for (const candidate of candidates) {
      let cleanupTarget = candidate;
      if (path.dirname(candidate) !== paths.trashRoot) {
        cleanupTarget = path.join(paths.trashRoot, `${extensionId}-${randomUUID()}`);
        try {
          await fs.rename(candidate, cleanupTarget);
        } catch {
          complete = false;
          continue;
        }
      }
      try {
        await this.removeTree(cleanupTarget);
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serialTail;
    let release: () => void = () => undefined;
    this.serialTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function isExtensionBusyError(error: unknown): boolean {
  return (
    (error instanceof ExtensionLifecycleError && error.code === 'EXTENSION_BUSY') ||
    (error instanceof ExtensionWorkerError && error.code === 'EXTENSION_BUSY')
  );
}
