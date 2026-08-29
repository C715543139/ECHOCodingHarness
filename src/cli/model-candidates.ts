import type { ModelCatalogConfig } from '../contracts/config.js';

/**
 * Chat-facing catalog snapshot. Structurally compatible with P1-2B
 * `ModelCatalogSnapshot` so merge can inject `ProcessModelCatalog`.
 */
export interface ChatModelCatalogSnapshot {
  readonly status: 'ok' | 'failed';
  readonly source: 'discover' | 'manual';
  readonly models: readonly string[];
  readonly cached: boolean;
  readonly refreshed: boolean;
  readonly configuredModel: string;
  readonly error?: Readonly<{ message: string }>;
}

/**
 * Narrow port Chat consumes for `/model` and `/model refresh`.
 * Chat must not issue `GET /models` or keep a process-wide discovery cache.
 */
export interface ChatModelCatalog {
  listCandidates(
    options?: Readonly<{
      refresh?: boolean;
      signal?: AbortSignal;
      configuredModel?: string;
    }>,
  ): Promise<ChatModelCatalogSnapshot>;
}

export const UNATTACHED_CATALOG_MESSAGE =
  'Model catalog port is not attached. Discover remains owned by the Provider catalog module.';

export const MANUAL_REFRESH_MESSAGE =
  '/model refresh is only available when modelCatalog.source is discover.';

export function uniqueChatModelIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function isSelectableChatModel(
  modelId: string,
  snapshot: ChatModelCatalogSnapshot,
): boolean {
  const id = modelId.trim();
  if (id.length === 0) {
    return false;
  }
  if (snapshot.source === 'manual') {
    return snapshot.models.includes(id);
  }
  if (id === snapshot.configuredModel) {
    return true;
  }
  if (snapshot.status === 'ok' || snapshot.cached) {
    return snapshot.models.includes(id);
  }
  return false;
}

export function formatCatalogFeedback(snapshot: ChatModelCatalogSnapshot): string[] {
  const lines = [
    snapshot.configuredModel,
    snapshot.models.length === 0 ? 'Candidates: none' : `Candidates: ${snapshot.models.join(', ')}`,
  ];
  if (snapshot.source === 'manual' && snapshot.refreshed) {
    lines.push(MANUAL_REFRESH_MESSAGE);
  }
  if (snapshot.status === 'failed' && snapshot.error !== undefined) {
    lines.push(snapshot.error.message);
  }
  return lines;
}

/**
 * Default Chat catalog when P1-2B `ProcessModelCatalog` is not injected.
 * Manual lists come from config. Discover never contacts the network.
 */
export class ConfigBackedChatCatalog implements ChatModelCatalog {
  constructor(
    private readonly catalog: ModelCatalogConfig,
    private readonly configuredModel: string,
  ) {}

  async listCandidates(
    options: Readonly<{
      refresh?: boolean;
      signal?: AbortSignal;
      configuredModel?: string;
    }> = {},
  ): Promise<ChatModelCatalogSnapshot> {
    const configuredModel = options.configuredModel ?? this.configuredModel;
    const refreshed = options.refresh === true;
    if (options.signal?.aborted) {
      return cancelledSnapshot(this.catalog.source, configuredModel, refreshed);
    }
    if (this.catalog.source === 'manual') {
      return {
        status: 'ok',
        source: 'manual',
        models: uniqueChatModelIds(this.catalog.models),
        cached: false,
        refreshed,
        configuredModel,
      };
    }
    return {
      status: 'failed',
      source: 'discover',
      models: uniqueChatModelIds([configuredModel]),
      cached: false,
      refreshed,
      configuredModel,
      error: { message: UNATTACHED_CATALOG_MESSAGE },
    };
  }
}

function cancelledSnapshot(
  source: 'discover' | 'manual',
  configuredModel: string,
  refreshed: boolean,
): ChatModelCatalogSnapshot {
  return {
    status: 'failed',
    source,
    models: uniqueChatModelIds([configuredModel]),
    cached: false,
    refreshed,
    configuredModel,
    error: { message: 'The model catalog request was cancelled.' },
  };
}
