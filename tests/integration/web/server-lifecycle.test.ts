import { describe, expect, it } from 'vitest';

import { WEB_SERVER_HOST } from '../../../src/web/server/index.js';

import { startTestWebServer } from './harness.js';

describe('Web server lifecycle', () => {
  it('listens only on 127.0.0.1 and reports the actual port', async () => {
    const harness = await startTestWebServer();
    try {
      const address = harness.server.app.server.address();
      expect(address).toEqual(
        expect.objectContaining({ address: WEB_SERVER_HOST, port: harness.server.port }),
      );
      expect(harness.server.port).toBeGreaterThan(0);
      expect(harness.server.bootstrapUrl).toBe(
        `http://${WEB_SERVER_HOST}:${String(harness.server.port)}/#bootstrap=${harness.server.bootstrapToken}`,
      );
      expect(harness.server.bootstrapToken).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      await harness.server.close();
    }
  });
});
