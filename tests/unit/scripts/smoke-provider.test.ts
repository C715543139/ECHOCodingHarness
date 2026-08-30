import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('smoke-provider source contract', () => {
  it('inspects the persisted Session JSONL instead of counting stream deltas', async () => {
    const source = await fs.readFile(path.join(ROOT, 'scripts', 'smoke-provider.mjs'), 'utf8');

    expect(source).toContain('ECHO_RUN_PROVIDER_SMOKE');
    expect(source).toContain('OpenAICompatibleProvider');
    expect(source).toContain('assertAggregatedSessionJsonl');
    expect(source).toContain('.jsonl');
    expect(source).toContain('.echo');
    expect(source).toContain('sessions');
    expect(source).toContain('readFileSync');
    expect(source).toContain('Provider smoke check passed.');
    expect(source).toContain(
      'Provider smoke check skipped. Set ECHO_RUN_PROVIDER_SMOKE=1 to enable a real request.',
    );
    expect(source).not.toContain('.env.test');
    expect(source).not.toContain('echo-harness');
    expect(source).not.toContain('loadRuntimeConfig');
    expect(source).not.toContain('textLength');
    expect(source).not.toContain('no completed text response');
  });
});
