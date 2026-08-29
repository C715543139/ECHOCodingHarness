import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EchoApplicationService } from '../../../src/application/index.js';
import { EventContextBuilder } from '../../../src/context/index.js';
import type { ModelCatalogClient } from '../../../src/contracts/index.js';
import {
  clearModelCatalogProcessCache,
  FakeProvider,
  isSelectableCatalogModel,
  listModelCandidates,
  ProcessModelCatalog,
  uniqueModelIds,
} from '../../../src/provider/index.js';
import { createProviderIdentity, JsonlSessionRepository } from '../../../src/session/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';

const retryOnce = { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 } as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  clearModelCatalogProcessCache();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function recordingClient(
  lists: readonly (readonly string[] | Error | { status: number; message: string })[],
): ModelCatalogClient & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async listModelIds() {
      const next = lists[calls];
      calls += 1;
      if (next === undefined) {
        throw new Error('unexpected catalog request');
      }
      if (next instanceof Error) {
        throw next;
      }
      if ('status' in next && !Array.isArray(next)) {
        throw next;
      }
      return next;
    },
  };
}

describe('uniqueModelIds', () => {
  it('trims, drops empties, and keeps first-seen order', () => {
    expect(uniqueModelIds([' model-a ', '', 'model-b', 'model-a', '  '])).toEqual([
      'model-a',
      'model-b',
    ]);
  });
});

describe('ProcessModelCatalog', () => {
  it('returns the manual list without contacting the Provider', async () => {
    const client = recordingClient([['ignored']]);
    const catalog = new ProcessModelCatalog({
      catalog: { source: 'manual', models: ['model-a', 'model-b'] },
      configuredModel: 'model-a',
      cacheKey: 'manual-key',
      client,
      retryPolicy: retryOnce,
    });

    const first = await catalog.listCandidates();
    const refreshed = await catalog.listCandidates({ refresh: true });

    expect(client.calls).toBe(0);
    expect(first).toMatchObject({
      status: 'ok',
      source: 'manual',
      models: ['model-a', 'model-b'],
      cached: false,
      configuredModel: 'model-a',
    });
    expect(refreshed.models).toEqual(['model-a', 'model-b']);
    expect(isSelectableCatalogModel('model-b', first)).toBe(true);
    expect(isSelectableCatalogModel('other', first)).toBe(false);
    expect(isSelectableCatalogModel('  ', first)).toBe(false);
  });

  it('rejects /model refresh when the catalog is manual', async () => {
    const client = recordingClient([['ignored']]);
    const catalog = new ProcessModelCatalog({
      catalog: { source: 'manual', models: ['only'] },
      configuredModel: 'only',
      cacheKey: 'manual-refresh',
      client,
      retryPolicy: retryOnce,
    });
    const snapshot = await catalog.listCandidates({ refresh: true });
    expect(client.calls).toBe(0);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.refreshed).toBe(false);
    expect(snapshot.models).toEqual(['only']);
    expect(snapshot.error?.message).toMatch(/discover/u);
    expect(isSelectableCatalogModel('only', snapshot)).toBe(true);
  });

  it('does not list models until /model asks for candidates', async () => {
    const client = recordingClient([['discovered-a', 'discovered-b']]);
    const catalog = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'configured-model',
      cacheKey: 'lazy-key',
      client,
      retryPolicy: retryOnce,
    });

    expect(client.calls).toBe(0);
    const snapshot = await catalog.listCandidates();
    expect(client.calls).toBe(1);
    expect(snapshot).toMatchObject({
      status: 'ok',
      source: 'discover',
      cached: false,
      refreshed: false,
      configuredModel: 'configured-model',
    });
    expect(snapshot.models).toEqual(['configured-model', 'discovered-a', 'discovered-b']);
  });

  it('uses only model IDs, de-duplicates, and caches in-process', async () => {
    const client = recordingClient([['dup', 'keep', 'dup', '', 'keep'], ['second-fetch']]);
    const firstCatalog = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'configured',
      cacheKey: 'shared-endpoint',
      client,
      retryPolicy: retryOnce,
    });
    const first = await firstCatalog.listCandidates();
    const otherInstance = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'configured',
      cacheKey: 'shared-endpoint',
      client,
      retryPolicy: retryOnce,
    });
    const cached = await otherInstance.listCandidates();

    expect(client.calls).toBe(1);
    expect(first.models).toEqual(['configured', 'dup', 'keep']);
    expect(cached).toMatchObject({ status: 'ok', cached: true, refreshed: false });
    expect(cached.models).toEqual(['configured', 'dup', 'keep']);
  });

  it('refresh bypasses cache and replaces it on success', async () => {
    const client = recordingClient([['first-a'], ['second-a', 'second-b']]);
    const catalog = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'configured',
      cacheKey: 'refresh-key',
      client,
      retryPolicy: retryOnce,
    });

    await catalog.listCandidates();
    const refreshed = await catalog.listCandidates({ refresh: true });
    const after = await catalog.listCandidates();

    expect(client.calls).toBe(2);
    expect(refreshed).toMatchObject({ status: 'ok', cached: false, refreshed: true });
    expect(refreshed.models).toEqual(['configured', 'second-a', 'second-b']);
    expect(after.cached).toBe(true);
    expect(after.models).toEqual(['configured', 'second-a', 'second-b']);
  });

  it('keeps the configured model when discovery fails and does not leak secrets', async () => {
    const client = recordingClient([
      {
        status: 401,
        message: 'Bearer sk-live-secretvalue99 rejected for Authorization: secret',
      },
    ]);
    const catalog = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'configured-model',
      cacheKey: 'auth-key',
      client,
      retryPolicy: retryOnce,
    });

    const snapshot = await catalog.listCandidates();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.models).toEqual(['configured-model']);
    expect(isSelectableCatalogModel('configured-model', snapshot)).toBe(true);
    expect(isSelectableCatalogModel('other-model', snapshot)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toMatch(/sk-live-secretvalue99|Bearer sk-/u);
    expect(snapshot.error).toMatchObject({
      category: 'provider_auth',
      code: 'PROVIDER_AUTH_FAILED',
      retryable: false,
    });
  });

  it('covers network, timeout, cancel, empty, and invalid list failures without blocking the configured model', async () => {
    const network = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'keep-me',
      cacheKey: 'net-key',
      client: recordingClient([new Error('ECONNRESET api_key=sk-leakkeyvalue')]),
      retryPolicy: retryOnce,
    });
    const networkSnapshot = await network.listCandidates();
    expect(networkSnapshot.status).toBe('failed');
    expect(networkSnapshot.models).toEqual(['keep-me']);
    expect(networkSnapshot.error?.category).toBe('provider_network');
    expect(JSON.stringify(networkSnapshot)).not.toContain('sk-leakkeyvalue');

    const timeoutError = new Error('timed out');
    timeoutError.name = 'APIConnectionTimeoutError';
    const timeout = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'keep-me',
      cacheKey: 'timeout-key',
      client: recordingClient([timeoutError]),
      retryPolicy: retryOnce,
    });
    const timeoutSnapshot = await timeout.listCandidates();
    expect(timeoutSnapshot.error).toMatchObject({
      category: 'provider_network',
      code: 'PROVIDER_TIMEOUT',
    });
    expect(timeoutSnapshot.models).toEqual(['keep-me']);

    const cancelled = new AbortController();
    cancelled.abort();
    const cancelCatalog = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'keep-me',
      cacheKey: 'cancel-key',
      client: recordingClient([['should-not-run']]),
      retryPolicy: retryOnce,
    });
    const cancelSnapshot = await cancelCatalog.listCandidates({ signal: cancelled.signal });
    expect(cancelSnapshot.error).toMatchObject({ category: 'cancelled' });
    expect(cancelSnapshot.models).toEqual(['keep-me']);

    const empty = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'keep-me',
      cacheKey: 'empty-key',
      client: recordingClient([['  ', '']]),
      retryPolicy: retryOnce,
    });
    const emptySnapshot = await empty.listCandidates();
    expect(emptySnapshot.error).toMatchObject({
      category: 'provider_protocol',
      code: 'PROVIDER_MODEL_LIST_EMPTY',
    });
    expect(emptySnapshot.models).toEqual(['keep-me']);
  });

  it('keeps a previous cache when refresh fails', async () => {
    const client = recordingClient([['cached-a'], new Error('temporary outage')]);
    const catalog = new ProcessModelCatalog({
      catalog: { source: 'discover' },
      configuredModel: 'configured',
      cacheKey: 'stale-key',
      client,
      retryPolicy: retryOnce,
    });
    await catalog.listCandidates();
    const failed = await catalog.listCandidates({ refresh: true });

    expect(failed.status).toBe('failed');
    expect(failed.cached).toBe(true);
    expect(failed.models).toEqual(['configured', 'cached-a']);
    expect(isSelectableCatalogModel('cached-a', failed)).toBe(true);
  });

  it('does not write the config file when the session model changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-catalog-session-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'config', 'echo.config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      baseUrl: 'https://provider.example/v1',
      model: 'configured-model',
      modelCatalog: { source: 'manual', models: ['configured-model', 'other-model'] },
      safetyMode: 'balanced',
    });
    await fs.writeFile(configPath, original, 'utf8');

    const identity = createProviderIdentity('https://provider.example/v1');
    const provider = new FakeProvider(
      [{ events: [{ type: 'completed', finishReason: 'stop' }] }],
      'fake',
      [{ ids: ['configured-model', 'other-model'] }],
    );
    const service = new EchoApplicationService({
      repository: new JsonlSessionRepository({ workspaceRoot: directory }),
      provider,
      providerIdentity: identity,
      tools: new ToolRegistry([]),
      policy: { evaluate: async () => ({ action: 'allow', reason: 'allow' }) },
      contextBuilder: new EventContextBuilder({ systemPrompt: 'system' }),
      workspaceRoot: directory,
      maxSteps: 2,
      contextBudget: { maxApproxTokens: 1_000, reservedOutputTokens: 100 },
      toolLimits: { timeoutMs: 1_000, maxOutputChars: 1_000 },
      unattendedApproval: 'deny',
    });
    const session = await service.createSession({
      workspaceRoot: directory,
      provider: identity,
      model: { value: 'configured-model', source: 'config' },
      safetyMode: { value: 'balanced', source: 'config' },
    });
    const catalog = new ProcessModelCatalog({
      catalog: { source: 'manual', models: ['configured-model', 'other-model'] },
      configuredModel: session.model.value,
      cacheKey: identity.endpointFingerprint,
      client: provider,
      retryPolicy: retryOnce,
    });
    const snapshot = await catalog.listCandidates();
    expect(isSelectableCatalogModel('other-model', snapshot)).toBe(true);

    const updated = await service.setSessionModel(session.sessionId, 'other-model');
    expect(updated.model).toEqual({ value: 'other-model', source: 'session' });
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    expect(provider.listModelCallCount).toBe(0);
  });

  it('lets CLI --model win over the config file without discovering, and applies a session switch on the next turn', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-catalog-priority-'));
    temporaryDirectories.push(directory);
    const identity = createProviderIdentity('https://provider.example/v1');
    const provider = new FakeProvider(
      [
        {
          events: [
            { type: 'text_delta', delta: 'first' },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
        {
          events: [
            { type: 'text_delta', delta: 'second' },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
      ],
      'fake',
      [{ ids: ['config-model', 'session-model'] }],
    );
    const service = new EchoApplicationService({
      repository: new JsonlSessionRepository({ workspaceRoot: directory }),
      provider,
      providerIdentity: identity,
      tools: new ToolRegistry([]),
      policy: { evaluate: async () => ({ action: 'allow', reason: 'allow' }) },
      contextBuilder: new EventContextBuilder({ systemPrompt: 'system' }),
      workspaceRoot: directory,
      maxSteps: 2,
      contextBudget: { maxApproxTokens: 1_000, reservedOutputTokens: 100 },
      toolLimits: { timeoutMs: 1_000, maxOutputChars: 1_000 },
      unattendedApproval: 'deny',
    });
    const session = await service.createSession({
      workspaceRoot: directory,
      provider: identity,
      model: { value: 'cli-model', source: 'cli' },
      safetyMode: { value: 'balanced', source: 'config' },
    });
    expect(session.model).toEqual({ value: 'cli-model', source: 'cli' });
    const first = await service.runTurn({ sessionId: session.sessionId, goal: 'first' });
    expect(first.finalText).toBe('first');
    expect(provider.requests[0]?.model).toBe('cli-model');
    expect(provider.listModelCallCount).toBe(0);

    await service.setSessionModel(session.sessionId, 'session-model');
    const second = await service.runTurn({ sessionId: session.sessionId, goal: 'second' });
    expect(second.finalText).toBe('second');
    expect(provider.requests[1]?.model).toBe('session-model');
    expect(provider.listModelCallCount).toBe(0);
  });

  it('exposes Chat /model candidates without leaking secrets and keeps the current model on failure', async () => {
    const discover = async () => ['alpha', 'beta'];
    const listed = await listModelCandidates({
      catalog: { source: 'discover' },
      current: 'alpha',
      cacheKey: 'chat-key',
      discover,
      retryPolicy: retryOnce,
    });
    expect(listed).toMatchObject({
      current: 'alpha',
      models: ['alpha', 'beta'],
      source: 'discover',
      cached: false,
      refreshed: false,
    });

    const cached = await listModelCandidates({
      catalog: { source: 'discover' },
      current: 'alpha',
      cacheKey: 'chat-key',
      discover: async () => {
        throw new Error('should use cache');
      },
      retryPolicy: retryOnce,
    });
    expect(cached.cached).toBe(true);
    expect(cached.models).toEqual(['alpha', 'beta']);

    const failed = await listModelCandidates({
      catalog: { source: 'discover' },
      current: 'alpha',
      cacheKey: 'chat-key',
      refresh: true,
      discover: async () => {
        throw new Error('Bearer sk-live-secretvalue99 network down');
      },
      retryPolicy: retryOnce,
    });
    expect(failed.error).toContain('unchanged');
    expect(failed.models).toEqual(['alpha', 'beta']);
    expect(JSON.stringify(failed)).not.toMatch(/sk-live-secretvalue99/u);

    const missing = await listModelCandidates({
      catalog: { source: 'discover' },
      current: 'keep-me',
      cacheKey: 'missing-client',
      retryPolicy: retryOnce,
    });
    expect(missing.models).toEqual(['keep-me']);
    expect(missing.error).toContain('unchanged');
    expect(
      isSelectableCatalogModel('keep-me', {
        status: 'failed',
        source: 'discover',
        models: missing.models,
        cached: false,
        refreshed: false,
        configuredModel: 'keep-me',
      }),
    ).toBe(true);
  });
});
