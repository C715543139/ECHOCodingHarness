import { describe, expect, it } from 'vitest';

import { startTestWebServer } from './harness.js';

describe('Web shutdown', () => {
  it('closes the loopback listener within the documented cleanup window', async () => {
    const harness = await startTestWebServer();
    const started = Date.now();
    await expect(harness.server.close()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(harness.server.app.server.listening).toBe(false);
  });
});
