import type { ExtensionManifest, ToolDefinition } from '../contracts/index.js';
import type { RegisteredTool, ToolRegistry } from '../tools/index.js';

import { ExtensionWorkerError } from './errors.js';
import {
  ExtensionWorkerHost,
  type ExtensionWorkerFault,
  type ExtensionWorkerHostOptions,
} from './worker-host.js';

export interface ExtensionRuntimeManagerOptions {
  readonly registry: ToolRegistry;
  readonly workspaceRoot: string;
  readonly onQuarantine?: (fault: ExtensionWorkerFault) => void | Promise<void>;
  readonly workerOptions?: Omit<ExtensionWorkerHostOptions, 'onFault'>;
}

export class ExtensionRuntimeManager {
  private readonly hosts = new Map<string, ExtensionWorkerHost>();

  constructor(private readonly options: ExtensionRuntimeManagerOptions) {}

  async load(extensionRoot: string, manifest: ExtensionManifest): Promise<void> {
    if (this.hosts.has(manifest.id)) {
      throw new ExtensionWorkerError(
        'REGISTRY_CONFLICT',
        `Extension "${manifest.id}" is already loaded.`,
      );
    }
    const opening: { host?: ExtensionWorkerHost } = {};
    const host = await ExtensionWorkerHost.open(
      {
        extensionId: manifest.id,
        extensionRoot,
        workspaceRoot: this.options.workspaceRoot,
        manifest,
      },
      {
        ...this.options.workerOptions,
        onFault: (fault) => this.handleFault(fault, opening.host),
      },
    );
    opening.host = host;
    if (host.closed) {
      throw new ExtensionWorkerError(
        'WORKER_CRASHED',
        `Extension "${manifest.id}" worker closed before registration.`,
      );
    }
    const tools = manifest.tools.map((tool): ToolDefinition<unknown> => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: (input, context) => host.execute(tool.name, input, context),
    })) as readonly RegisteredTool[];
    try {
      this.options.registry.registerExtension(manifest.id, tools);
      this.hosts.set(manifest.id, host);
    } catch (error) {
      await host.shutdown();
      throw new ExtensionWorkerError(
        'REGISTRY_CONFLICT',
        `Extension "${manifest.id}" tools could not be registered.`,
        error,
      );
    }
  }

  isLoaded(extensionId: string): boolean {
    return this.hosts.has(extensionId);
  }

  loadedExtensionIds(): readonly string[] {
    return [...this.hosts.keys()];
  }

  activeCallCount(extensionId: string): number {
    return this.hosts.get(extensionId)?.activeCallCount ?? 0;
  }

  async unload(extensionId: string): Promise<boolean> {
    const host = this.hosts.get(extensionId);
    if (host === undefined) return false;
    if (host.activeCallCount > 0) {
      throw new ExtensionWorkerError('EXTENSION_BUSY', 'Extension has active calls.');
    }
    this.options.registry.unregisterExtension(extensionId);
    this.hosts.delete(extensionId);
    await host.shutdown();
    return true;
  }

  async shutdownAll(): Promise<void> {
    const entries = [...this.hosts];
    for (const [extensionId] of entries) this.options.registry.unregisterExtension(extensionId);
    this.hosts.clear();
    await Promise.all(entries.map(([, host]) => host.shutdown()));
  }

  private handleFault(fault: ExtensionWorkerFault, host: ExtensionWorkerHost | undefined): void {
    const current = this.hosts.get(fault.extensionId);
    if (current !== undefined && host !== undefined && current !== host) return;
    this.options.registry.unregisterExtension(fault.extensionId);
    this.hosts.delete(fault.extensionId);
    void this.options.onQuarantine?.(fault);
  }
}
