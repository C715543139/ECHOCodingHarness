import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigBackedChatCatalog,
  formatCatalogFeedback,
  isSelectableChatModel,
  UNATTACHED_CATALOG_MESSAGE,
  uniqueChatModelIds,
  type ChatModelCatalogSnapshot,
} from '../../../src/cli/model-candidates.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function snapshot(
  overrides: Partial<ChatModelCatalogSnapshot> &
    Pick<ChatModelCatalogSnapshot, 'source' | 'configuredModel' | 'models'>,
): ChatModelCatalogSnapshot {
  return {
    status: 'ok',
    cached: false,
    refreshed: false,
    ...overrides,
  };
}

describe('chat model catalog port', () => {
  it('lists the manual catalog without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const catalog = new ConfigBackedChatCatalog(
      { source: 'manual', models: ['model-a', 'model-b'] },
      'model-a',
    );
    const result = await catalog.listCandidates();
    expect(result).toEqual({
      status: 'ok',
      source: 'manual',
      models: ['model-a', 'model-b'],
      cached: false,
      refreshed: false,
      configuredModel: 'model-a',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not discover over the network when the catalog port is unattached', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const catalog = new ConfigBackedChatCatalog({ source: 'discover' }, 'alpha');
    const result = await catalog.listCandidates({ refresh: true });
    expect(result.status).toBe('failed');
    expect(result.models).toEqual(['alpha']);
    expect(result.error?.message).toBe(UNATTACHED_CATALOG_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a cancelled snapshot when the list signal is already aborted', async () => {
    const catalog = new ConfigBackedChatCatalog({ source: 'discover' }, 'alpha');
    const controller = new AbortController();
    controller.abort();
    const result = await catalog.listCandidates({ signal: controller.signal, refresh: true });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/cancelled/u);
  });

  it('accepts only selectable catalog candidates', () => {
    expect(
      isSelectableChatModel(
        'other',
        snapshot({ source: 'manual', configuredModel: 'current', models: ['current', 'other'] }),
      ),
    ).toBe(true);
    expect(
      isSelectableChatModel(
        'missing',
        snapshot({ source: 'manual', configuredModel: 'current', models: ['current'] }),
      ),
    ).toBe(false);
    expect(
      isSelectableChatModel(
        'current',
        snapshot({
          status: 'failed',
          source: 'discover',
          configuredModel: 'current',
          models: ['current'],
        }),
      ),
    ).toBe(true);
    expect(
      isSelectableChatModel(
        'discovered',
        snapshot({
          status: 'failed',
          source: 'discover',
          configuredModel: 'current',
          models: ['current'],
        }),
      ),
    ).toBe(false);
    expect(
      isSelectableChatModel(
        'discovered',
        snapshot({
          source: 'discover',
          configuredModel: 'current',
          models: ['current', 'discovered'],
        }),
      ),
    ).toBe(true);
    expect(
      isSelectableChatModel(
        '  ',
        snapshot({ source: 'manual', configuredModel: 'a', models: ['a'] }),
      ),
    ).toBe(false);
  });

  it('formats catalog feedback and unique ids without duplicating blanks', () => {
    expect(uniqueChatModelIds([' a ', 'a', '', 'b'])).toEqual(['a', 'b']);
    expect(
      formatCatalogFeedback(
        snapshot({
          source: 'manual',
          configuredModel: 'a',
          models: ['a', 'b'],
          refreshed: true,
        }),
      ),
    ).toEqual([
      'a',
      'Candidates: a, b',
      '/model refresh is only available when modelCatalog.source is discover.',
    ]);
  });
});
