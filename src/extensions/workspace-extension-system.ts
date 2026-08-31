import type { SafetyMode } from '../contracts/index.js';
import type { ToolRegistry } from '../tools/index.js';

import { ExtensionLifecycleManager } from './lifecycle-manager.js';
import { createExtensionLifecycleTools } from './lifecycle-tools.js';

const LIFECYCLE_TOOL_OWNER = '$echo:lifecycle';

export interface WorkspaceExtensionSystemOptions {
  readonly workspaceRoot: string;
  readonly registry: ToolRegistry;
}

/**
 * Coordinates persisted workspace extensions with one process-local ToolRegistry.
 * Persisted state belongs to the workspace; visibility belongs to the active
 * Session safety mode and is reconciled immediately before a Turn starts.
 */
export class WorkspaceExtensionSystem {
  readonly lifecycle: ExtensionLifecycleManager;
  private lifecycleRegistered = false;
  private closed = false;
  private serialTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly registry: ToolRegistry,
    lifecycle: ExtensionLifecycleManager,
    private readonly state: { runtimeAllowed: boolean },
  ) {
    this.lifecycle = lifecycle;
  }

  static async open(options: WorkspaceExtensionSystemOptions): Promise<WorkspaceExtensionSystem> {
    const state = { runtimeAllowed: false };
    const lifecycle = await ExtensionLifecycleManager.open({
      workspaceRoot: options.workspaceRoot,
      registry: options.registry,
      runtimeAllowed: () => state.runtimeAllowed,
    });
    return new WorkspaceExtensionSystem(options.registry, lifecycle, state);
  }

  async prepareForTurn(mode: SafetyMode, signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen();
      if (signal?.aborted === true) throw signal.reason;
      if (mode !== 'full-access') {
        this.setRuntimeAllowed(false);
        this.unregisterLifecycleTools();
        await this.lifecycle.deactivateRuntime();
        return;
      }

      this.setRuntimeAllowed(true);
      this.registerLifecycleTools();
      try {
        await this.lifecycle.activateEnabled(signal);
      } catch (error) {
        this.setRuntimeAllowed(false);
        this.unregisterLifecycleTools();
        await this.lifecycle.deactivateRuntime();
        throw error;
      }
    });
  }

  isRuntimeActive(): boolean {
    return this.state.runtimeAllowed;
  }

  async close(): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) return;
      this.closed = true;
      this.setRuntimeAllowed(false);
      this.unregisterLifecycleTools();
      await this.lifecycle.close();
    });
  }

  private setRuntimeAllowed(allowed: boolean): void {
    this.state.runtimeAllowed = allowed;
  }

  private registerLifecycleTools(): void {
    if (this.lifecycleRegistered) return;
    this.registry.registerExtension(
      LIFECYCLE_TOOL_OWNER,
      createExtensionLifecycleTools(this.lifecycle),
    );
    this.lifecycleRegistered = true;
  }

  private unregisterLifecycleTools(): void {
    if (!this.lifecycleRegistered) return;
    this.registry.unregisterExtension(LIFECYCLE_TOOL_OWNER);
    this.lifecycleRegistered = false;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Workspace extension system is closed.');
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
