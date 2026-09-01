import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  FULL_ACCESS_CONFIRMATION_SOURCES,
  P3_EXTENSION_CATALOG_SCHEMA_VERSION,
  P3_EXTENSION_LIFECYCLE_TOOLS,
  P3_EXTENSION_MANIFEST_SCHEMA_VERSION,
  P3_EXTENSION_STATES,
  P3_EXTENSION_WORKER_REQUESTS,
  P3_EXTENSION_WORKER_RESPONSES,
  P3_SAFETY_MODES,
  P3_TEST_MATRIX,
  type ExtensionCatalog,
  type ExtensionManifest,
  type FullAccessConfirmation,
  type P3SafetyMode,
} from '../../../src/contracts/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function readDoc(relativePath: string): Promise<string> {
  return fs.readFile(path.join(ROOT, relativePath), 'utf8');
}

describe('P3 contracts', () => {
  it('freezes the target modes, explicit confirmation, lifecycle, states, and worker messages', () => {
    expect(P3_SAFETY_MODES).toEqual(['safe', 'balanced', 'auto', 'full-access']);
    expect(FULL_ACCESS_CONFIRMATION_SOURCES).toEqual(['cli-interactive', 'cli-flag', 'web-dialog']);
    expect(P3_EXTENSION_STATES).toEqual(['enabled', 'disabled', 'quarantined']);
    expect(P3_EXTENSION_LIFECYCLE_TOOLS).toEqual([
      'extension_init',
      'extension_check',
      'extension_install',
      'extension_list',
      'extension_enable',
      'extension_disable',
      'extension_uninstall',
    ]);
    expect(P3_EXTENSION_WORKER_REQUESTS).toEqual(['initialize', 'execute', 'cancel', 'shutdown']);
    expect(P3_EXTENSION_WORKER_RESPONSES).toEqual(['ready', 'result', 'failure', 'protocol_error']);
    expect(P3_EXTENSION_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(P3_EXTENSION_CATALOG_SCHEMA_VERSION).toBe(1);

    expectTypeOf<P3SafetyMode>().toEqualTypeOf<'safe' | 'balanced' | 'auto' | 'full-access'>();
    expectTypeOf<FullAccessConfirmation['acceptedRisk']>().toEqualTypeOf<true>();
    expectTypeOf<ExtensionManifest>().toHaveProperty('selfTest');
    expectTypeOf<ExtensionCatalog>().toHaveProperty('revision');
  });

  it('keeps every accepted requirement uniquely owned with existing runtime evidence', async () => {
    const ids = P3_TEST_MATRIX.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(P3_TEST_MATRIX.length).toBeGreaterThanOrEqual(14);
    expect(P3_TEST_MATRIX.every((row) => row.contractEvidence.length > 0)).toBe(true);
    for (const row of P3_TEST_MATRIX) {
      expect(row.runtimeEvidence.length).toBeGreaterThan(0);
      for (const evidence of row.runtimeEvidence) {
        expect(evidence).not.toMatch(/^pending:/u);
        await expect(fs.stat(path.join(ROOT, evidence))).resolves.toBeDefined();
      }
    }
  });

  it('keeps P3 documents aligned on authority, scope, lifecycle, and exclusions', async () => {
    const files = await Promise.all([
      readDoc('docs/plans/p3-extensions.md'),
      readDoc('docs/plans/p3-acceptance-matrix.md'),
      readDoc('docs/decisions/0010-full-access-mode.md'),
      readDoc('docs/decisions/0011-workspace-extensions.md'),
      readDoc('docs/architecture.md'),
      readDoc('docs/contracts.md'),
      readDoc('docs/security.md'),
      readDoc('docs/testing.md'),
      readDoc('docs/web-api.md'),
      readDoc('docs/web-ui.md'),
      readDoc('AGENTS.md'),
    ]);

    for (const text of files) {
      expect(text).toContain('P3');
    }
    expect(files[0]).toContain('full-access');
    expect(files[0]).toContain('quarantined');
    expect(files[1]).toContain('Full Access');
    expect(files[1]).toContain('工作区');
    expect(files[2]).toContain('full-access');
    expect(files[3]).toContain('.echo/extensions');
    expect(files[3]).toContain('quarantined');
    expect(files[0]).toContain('extension_uninstall');
    expect(files[0]).toContain('下一次模型请求');
    expect(files[2]).toContain('--allow-full-access');
    expect(files[2]).toContain('模型不能');
    expect(files[3]).toContain('不构成 OS 沙箱');
    expect(files[3]).toContain('extension_busy');
    expect(files[9]).toContain('FULL ACCESS');
    expect(files[10]).toContain('0010-full-access-mode');
    expect(files[10]).toContain('0011-workspace-extensions');
  });
});
