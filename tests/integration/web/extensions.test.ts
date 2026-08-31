import { describe, expect, it, vi } from 'vitest';

import type { ExtensionMutationDto, ExtensionSummaryDto } from '../../../src/contracts/web.js';
import {
  ExtensionAdministrationError,
  type ExtensionAdministrationPort,
} from '../../../src/web/server/index.js';

import { startTestWebServer } from './harness.js';

const HASH = `sha256:${'a'.repeat(64)}`;

function requestHeaders(origin: string, id: string): Record<string, string> {
  return {
    origin,
    'content-type': 'application/json',
    'x-echo-request-id': `request-extension-${id}`,
  };
}

function administration(overrides: Partial<ExtensionAdministrationPort> = {}): {
  readonly port: ExtensionAdministrationPort;
  readonly enable: ReturnType<typeof vi.fn>;
  readonly disable: ReturnType<typeof vi.fn>;
  readonly uninstall: ReturnType<typeof vi.fn>;
} {
  const summary: ExtensionSummaryDto = {
    id: 'pdf-reader',
    version: '1.0.0',
    contentHash: HASH,
    state: 'enabled',
    tools: ['read_pdf'],
    loaded: true,
    cleanupPending: false,
    quarantineReason: 'failed at C:\\Users\\private-user\\repo with api_key=private-value',
  };
  const mutation = (state: ExtensionMutationDto['state']): ExtensionMutationDto => ({
    id: 'pdf-reader',
    state,
    loaded: state === 'enabled',
    changed: true,
    cleanupPending: false,
    contentHash: HASH,
    deactivated: state !== 'enabled',
  });
  const enable = vi.fn(async () => mutation('enabled'));
  const disable = vi.fn(async () => mutation('disabled'));
  const uninstall = vi.fn(async (): Promise<ExtensionMutationDto> => ({
    id: 'pdf-reader',
    state: 'absent',
    loaded: false,
    changed: true,
    cleanupPending: false,
    deactivated: true,
  }));
  return {
    enable,
    disable,
    uninstall,
    port: {
      list: async () => [summary],
      enable,
      disable,
      uninstall,
      ...overrides,
    },
  };
}

describe('Extension administration API', () => {
  it('returns bounded redacted current-workspace summaries without requiring Full Access', async () => {
    const fixture = administration();
    const harness = await startTestWebServer({
      extensionAdministration: fixture.port,
      env: { ECHO_API_KEY: 'private-value' },
    });
    try {
      const cookie = await harness.bootstrap();
      const created = await harness.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        cookies: cookie,
        headers: requestHeaders(harness.origin, 'create-safe-0001'),
        payload: { safetyMode: 'safe' },
      });
      expect(created.statusCode).toBe(201);

      const listed = await harness.inject({
        method: 'GET',
        url: '/api/v1/extensions',
        cookies: cookie,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({
        data: [
          {
            id: 'pdf-reader',
            version: '1.0.0',
            contentHash: HASH,
            state: 'enabled',
            tools: ['read_pdf'],
            loaded: true,
          },
        ],
      });
      expect(JSON.stringify(listed.json())).not.toMatch(/private-value|private-user|[A-Z]:\\/u);
    } finally {
      await harness.server.close();
    }
  });

  it('uses one idempotent mutation contract for enable, disable, and uninstall', async () => {
    const fixture = administration();
    const harness = await startTestWebServer({ extensionAdministration: fixture.port });
    try {
      const cookie = await harness.bootstrap();
      const invoke = (method: 'POST' | 'DELETE', action: string, requestId: string) =>
        harness.inject({
          method,
          url: `/api/v1/extensions/pdf-reader${action}`,
          cookies: cookie,
          headers: requestHeaders(harness.origin, requestId),
          payload: {},
        });

      const enabled = await invoke('POST', '/enable', 'enable-000000001');
      const replayed = await invoke('POST', '/enable', 'enable-000000001');
      expect(enabled.statusCode).toBe(200);
      expect(replayed.json()).toEqual(enabled.json());
      expect(enabled.json()).toMatchObject({
        data: {
          id: 'pdf-reader',
          state: 'enabled',
          loaded: true,
          changed: true,
          cleanupPending: false,
        },
      });
      expect(fixture.enable).toHaveBeenCalledTimes(1);

      expect((await invoke('POST', '/disable', 'disable-00000001')).statusCode).toBe(200);
      expect((await invoke('DELETE', '', 'uninstall-0000001')).statusCode).toBe(200);
      expect(fixture.disable).toHaveBeenCalledWith('pdf-reader');
      expect(fixture.uninstall).toHaveBeenCalledWith('pdf-reader');
    } finally {
      await harness.server.close();
    }
  });

  it('maps every lifecycle failure to its stable Web error code', async () => {
    const fixture = administration({
      list: async () => {
        throw new ExtensionAdministrationError('EXTENSION_NOT_FOUND');
      },
      enable: async () => {
        throw new ExtensionAdministrationError('EXTENSION_QUARANTINED');
      },
      disable: async () => {
        throw new ExtensionAdministrationError('EXTENSION_INVALID');
      },
      uninstall: async () => {
        throw new ExtensionAdministrationError('EXTENSION_CLEANUP_PENDING');
      },
    });
    const harness = await startTestWebServer({ extensionAdministration: fixture.port });
    try {
      const cookie = await harness.bootstrap();
      const listed = await harness.inject({
        method: 'GET',
        url: '/api/v1/extensions',
        cookies: cookie,
      });
      expect(listed.statusCode).toBe(404);
      expect(listed.json()).toMatchObject({ error: { code: 'EXTENSION_NOT_FOUND' } });

      const cases = [
        { method: 'POST' as const, suffix: '/enable', code: 'EXTENSION_QUARANTINED' },
        { method: 'POST' as const, suffix: '/disable', code: 'EXTENSION_INVALID' },
        { method: 'DELETE' as const, suffix: '', code: 'EXTENSION_CLEANUP_PENDING' },
      ];
      for (const [index, item] of cases.entries()) {
        const response = await harness.inject({
          method: item.method,
          url: `/api/v1/extensions/pdf-reader${item.suffix}`,
          cookies: cookie,
          headers: requestHeaders(harness.origin, `failure-${String(index).padStart(10, '0')}`),
          payload: {},
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: item.code } });
      }
    } finally {
      await harness.server.close();
    }
  });

  it('maps stable failures, rejects invalid inputs, and exposes the production workspace Catalog', async () => {
    const fixture = administration({
      disable: async () => {
        throw new ExtensionAdministrationError('EXTENSION_BUSY');
      },
    });
    const harness = await startTestWebServer({ extensionAdministration: fixture.port });
    try {
      const cookie = await harness.bootstrap();
      const busy = await harness.inject({
        method: 'POST',
        url: '/api/v1/extensions/pdf-reader/disable',
        cookies: cookie,
        headers: requestHeaders(harness.origin, 'busy-000000000001'),
        payload: {},
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ error: { code: 'EXTENSION_BUSY' } });
      expect(JSON.stringify(busy.json())).not.toContain('stack');

      const invalid = await harness.inject({
        method: 'POST',
        url: '/api/v1/extensions/..%2Foutside/enable',
        cookies: cookie,
        headers: requestHeaders(harness.origin, 'invalid-000000001'),
        payload: { workspaceRoot: 'elsewhere' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'WORKSPACE_MISMATCH' } });
    } finally {
      await harness.server.close();
    }

    const production = await startTestWebServer();
    try {
      const cookie = await production.bootstrap();
      const response = await production.inject({
        method: 'GET',
        url: '/api/v1/extensions',
        cookies: cookie,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: [] });
    } finally {
      await production.server.close();
    }
  });
});
