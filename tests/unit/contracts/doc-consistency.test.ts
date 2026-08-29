import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { P1_TEST_MATRIX } from '../../../src/contracts/p1-matrix.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function readDoc(relativePath: string): Promise<string> {
  return fs.readFile(path.join(ROOT, relativePath), 'utf8');
}

describe('P1 documentation freeze', () => {
  it('keeps ADR, contracts, architecture, testing, README, and the P1 plan aligned', async () => {
    const files = {
      adr2: await readDoc('docs/decisions/0002-p1-config-artifact-root.md'),
      adr3: await readDoc('docs/decisions/0003-p1-application-service-session.md'),
      contracts: await readDoc('docs/contracts.md'),
      architecture: await readDoc('docs/architecture.md'),
      testing: await readDoc('docs/testing.md'),
      readme: await readDoc('README.md'),
      plan: await readDoc('docs/plans/p1-cli.md'),
    };

    for (const text of Object.values(files)) {
      expect(text).toContain('artifact-root');
      expect(text).toContain('ECHO_API_KEY');
    }

    expect(files.contracts).toContain('CLI 显式参数 > echo.config.json');
    expect(files.contracts).not.toContain('CLI 显式参数 > echo.config.json > 内置默认值');
    expect(files.adr2).not.toContain('CLI 显式参数 > echo.config.json > 内置默认值');
    expect(files.contracts).toContain('session.resumed');
    expect(files.contracts).toContain('model.changed');
    expect(files.contracts).toContain('safety.changed');
    expect(files.contracts).toContain('respondToApproval');
    expect(files.contracts).toContain('create(input: CreateSessionRecordInput)');
    expect(files.contracts).toContain('EndpointFingerprint');
    expect(files.contracts).toContain('ApprovalResponseResult');
    expect(files.contracts).toContain('not_pending');
    expect(files.contracts).toContain('bracketed paste');
    expect(files.adr3).toContain('EndpointFingerprint');
    expect(files.adr3).toContain('not_pending');
    expect(files.testing).toContain('contractEvidence');
    expect(files.testing).toContain('runtimeEvidence');

    expect(files.architecture).toContain('Application service');
    expect(files.architecture).toContain('P1-2A');
    expect(files.plan).toContain('ADR-0002');
    expect(files.plan).toContain('ADR-0003');
    expect(files.testing).toContain('P1-0');
    expect(files.readme).toContain('P1-2A');

    expect(files.adr2).toContain('P1-2A');
    expect(files.adr3).toContain('P1-1A');
    expect(P1_TEST_MATRIX.length).toBeGreaterThanOrEqual(12);
  });

  it('does not use a user home directory as a documentation fixture path', async () => {
    const tmp = os.tmpdir();
    expect(tmp.length).toBeGreaterThan(0);
    const contracts = await readDoc('docs/contracts.md');
    expect(contracts).not.toMatch(/C:\\Users\\[^\\/]+\\/u);
  });
});
