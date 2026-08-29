import type {
  EchoError,
  ModelCatalogClient,
  ModelCatalogConfig,
  ModelCatalogSnapshot,
} from '../contracts/index.js';
import { CONFIG_ERROR_CODES } from '../contracts/index.js';

import {
  cancellationError,
  DEFAULT_RETRY_POLICY,
  providerError,
  toEchoError,
  type ProviderRetryPolicy,
  withRetries,
} from './errors.js';

export interface ProcessModelCatalogOptions {
  readonly catalog: ModelCatalogConfig;
  readonly configuredModel: string;
  readonly cacheKey: string;
  readonly client?: ModelCatalogClient;
  readonly timeoutMs?: number;
  readonly retryPolicy?: ProviderRetryPolicy;
}

export interface ListCandidateOptions {
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
  readonly configuredModel?: string;
}

const processCache = new Map<string, readonly string[]>();

export function clearModelCatalogProcessCache(): void {
  processCache.clear();
}

export function uniqueModelIds(ids: readonly string[]): string[] {
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

export function isSelectableCatalogModel(modelId: string, snapshot: ModelCatalogSnapshot): boolean {
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

function emptyListError(): EchoError {
  return providerError(
    'provider_protocol',
    'PROVIDER_MODEL_LIST_EMPTY',
    'The model catalog response did not include any model IDs.',
    false,
  );
}

function missingClientError(): EchoError {
  return {
    category: 'configuration',
    code: CONFIG_ERROR_CODES.invalidCatalog,
    message: 'Discover catalog requires a Provider client to list models.',
    retryable: false,
  };
}

function mergeCandidates(configuredModel: string, discovered: readonly string[]): string[] {
  return uniqueModelIds([configuredModel, ...discovered]);
}

/**
 * Process-cached model catalog. Manual mode never contacts the network.
 * Discover mode issues `GET {baseUrl}/models` and keeps only model IDs.
 */
export class ProcessModelCatalog {
  private readonly catalog: ModelCatalogConfig;
  private readonly configuredModel: string;
  private readonly cacheKey: string;
  private readonly client: ModelCatalogClient | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly retryPolicy: ProviderRetryPolicy;

  constructor(options: ProcessModelCatalogOptions) {
    this.catalog = options.catalog;
    this.configuredModel = options.configuredModel;
    this.cacheKey = options.cacheKey;
    this.client = options.client;
    this.timeoutMs = options.timeoutMs;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  async listCandidates(options: ListCandidateOptions = {}): Promise<ModelCatalogSnapshot> {
    const configuredModel = options.configuredModel ?? this.configuredModel;
    const refreshed = options.refresh === true;
    if (this.catalog.source === 'manual') {
      if (refreshed) {
        return {
          status: 'failed',
          source: 'manual',
          models: uniqueModelIds(this.catalog.models),
          cached: false,
          refreshed: false,
          configuredModel,
          error: {
            category: 'configuration',
            code: CONFIG_ERROR_CODES.invalidCatalog,
            message: 'Model refresh is only available when the catalog source is discover.',
            retryable: false,
          },
        };
      }
      return {
        status: 'ok',
        source: 'manual',
        models: uniqueModelIds(this.catalog.models),
        cached: false,
        refreshed: false,
        configuredModel,
      };
    }

    if (!refreshed) {
      const cached = processCache.get(this.cacheKey);
      if (cached !== undefined) {
        return {
          status: 'ok',
          source: 'discover',
          models: mergeCandidates(configuredModel, cached),
          cached: true,
          refreshed: false,
          configuredModel,
        };
      }
    }

    const signal = options.signal;
    if (signal?.aborted) {
      return this.failedDiscover(
        configuredModel,
        cancellationError('The model catalog request was cancelled.'),
        true,
      );
    }

    const client = this.client;
    if (client === undefined) {
      return this.failedDiscover(configuredModel, missingClientError(), refreshed);
    }

    try {
      const discovered = await withRetries(async (attempt) => {
        if (attempt > 1 && signal?.aborted) {
          throw cancellationError('The model catalog request was cancelled before retry.');
        }
        const ids = uniqueModelIds(
          await client.listModelIds({
            signal: signal ?? new AbortController().signal,
            ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
          }),
        );
        if (ids.length === 0) {
          throw emptyListError();
        }
        return ids;
      }, this.retryPolicy);
      processCache.set(this.cacheKey, discovered);
      return {
        status: 'ok',
        source: 'discover',
        models: mergeCandidates(configuredModel, discovered),
        cached: false,
        refreshed,
        configuredModel,
      };
    } catch (error) {
      return this.failedDiscover(configuredModel, toEchoError(error), refreshed);
    }
  }

  private failedDiscover(
    configuredModel: string,
    error: EchoError,
    refreshed: boolean,
  ): ModelCatalogSnapshot {
    const cached = processCache.get(this.cacheKey);
    return {
      status: 'failed',
      source: 'discover',
      models: mergeCandidates(configuredModel, cached ?? []),
      cached: cached !== undefined,
      refreshed,
      configuredModel,
      error,
    };
  }
}

export type DiscoverModels = (input: {
  readonly refresh: boolean;
  readonly signal?: AbortSignal;
}) => Promise<readonly string[]>;

export interface ModelCandidateList {
  readonly current: string;
  readonly models: readonly string[];
  readonly source: ModelCatalogConfig['source'];
  readonly refreshed: boolean;
  readonly cached: boolean;
  readonly error?: string;
}

export interface ListModelCandidatesInput {
  readonly catalog: ModelCatalogConfig;
  readonly current: string;
  readonly cacheKey: string;
  readonly refresh?: boolean;
  readonly discover?: DiscoverModels;
  readonly client?: ModelCatalogClient;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly retryPolicy?: ProviderRetryPolicy;
}

function candidateErrorMessage(snapshot: ModelCatalogSnapshot): string | undefined {
  if (snapshot.error === undefined) {
    return undefined;
  }
  if (snapshot.source === 'manual') {
    return snapshot.error.message;
  }
  const message = snapshot.error.message;
  if (message.includes('unchanged')) {
    return message;
  }
  return `${message} The current model is unchanged.`;
}

/**
 * Chat `/model` and `/model refresh` entry. Discovery stays in-process and never
 * blocks the already-configured current model.
 */
export async function listModelCandidates(
  input: ListModelCandidatesInput,
): Promise<ModelCandidateList> {
  const discover = input.discover;
  const client =
    input.client ??
    (discover === undefined
      ? undefined
      : {
          listModelIds: (options: Readonly<{ signal: AbortSignal; timeoutMs?: number }>) =>
            discover({
              refresh: input.refresh === true,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            }),
        });
  const catalog = new ProcessModelCatalog({
    catalog: input.catalog,
    configuredModel: input.current,
    cacheKey: input.cacheKey,
    ...(client === undefined ? {} : { client }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.retryPolicy === undefined ? {} : { retryPolicy: input.retryPolicy }),
  });
  const snapshot = await catalog.listCandidates({
    configuredModel: input.current,
    ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const error = candidateErrorMessage(snapshot);
  return {
    current: snapshot.configuredModel,
    models: snapshot.models,
    source: snapshot.source,
    refreshed: snapshot.refreshed,
    cached: snapshot.cached,
    ...(error === undefined ? {} : { error }),
  };
}
