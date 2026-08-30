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
      adr4: await readDoc('docs/decisions/0004-workspace-echo-config.md'),
      adr5: await readDoc('docs/decisions/0005-restore-artifact-config.md'),
      adr6: await readDoc('docs/decisions/0006-reasoning-session-events.md'),
      p15: await readDoc('docs/plans/p1-5-reasoning-context.md'),
      cliUx: await readDoc('docs/cli-ux.md'),
      contracts: await readDoc('docs/contracts.md'),
      architecture: await readDoc('docs/architecture.md'),
      testing: await readDoc('docs/testing.md'),
      readme: await readDoc('README.md'),
      plan: await readDoc('docs/plans/p1-cli.md'),
    };

    for (const text of [
      files.adr2,
      files.adr3,
      files.adr5,
      files.contracts,
      files.architecture,
      files.testing,
      files.readme,
      files.plan,
    ]) {
      expect(text).toContain('artifact-root');
      expect(text).toContain('ECHO_API_KEY');
      expect(text).toContain('config/echo.config.json');
    }

    expect(files.adr4).toContain('Superseded');
    expect(files.adr5).toContain('ADR-0004');
    expect(files.plan).toContain('ADR-0005');
    expect(files.architecture).toContain('ADR-0005');
    expect(files.contracts).not.toContain(
      '唯一持久配置文件为 `<workspace>/.echo/config/echo.config.json`',
    );

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
    expect(files.plan).toContain('ADR-0005');
    expect(files.testing).toContain('P1-0');
    expect(files.readme).toContain('P1-2A');
    expect(files.readme).toContain('P1-2B');
    expect(files.readme).toContain('chat --resume');
    expect(files.architecture).toContain('P1-2B');
    expect(files.architecture).toContain('P1-1B');
    expect(files.contracts).toContain('GET {baseUrl}/models');
    expect(files.testing).toContain('P1-2B');
    expect(files.testing).toContain('smoke:artifact');
    expect(files.testing).not.toContain('not yet implemented');
    expect(files.adr6).toContain('model.reasoning');
    expect(files.adr6).toContain('model.text');
    expect(files.adr6).toContain('EVENT_SCHEMA_VERSION');
    expect(files.adr6).toContain('type`/`text`/`format`/`index');
    expect(files.adr6).toContain('完全一致');
    expect(files.adr6).toContain('canonical `reasoning`');
    expect(files.adr6).toContain('整组数组原样保留');
    expect(files.adr6).not.toContain('逻辑项合并');
    expect(files.p15).toContain('all-or-nothing');
    expect(files.p15).toContain('details-only');
    expect(files.p15).toContain('整组数组及顺序必须原样保留');
    expect(files.contracts).toContain('type`/`text`/`format`/`index');
    expect(files.contracts).toContain('整组原样保留数组及顺序');
    expect(files.contracts).toContain('model.reasoning');
    expect(files.contracts).toContain('model.text');
    expect(files.contracts).toContain('output_limit');
    expect(files.contracts).toContain('256,000');
    expect(files.architecture).toContain('ADR-0006');
    expect(files.architecture).toContain('canonical `reasoning`');
    expect(files.testing).toContain('details-only canonical `reasoning`');
    const reasoningSource = await readDoc('src/provider/reasoning.ts');
    expect(reasoningSource).not.toContain("type === 'text'");
    expect(reasoningSource).not.toContain('details.filter');
    expect(reasoningSource).not.toContain('.includes(text)');
    expect(reasoningSource).not.toContain('isRedundantTextDetail');
    expect(reasoningSource).not.toContain('hasStringField');
    await expect(
      fs.access(path.join(ROOT, 'docs/decisions/0007-reasoning-details-merge.md')),
    ).rejects.toThrow();
    expect(await readDoc('src/provider/reasoning.ts')).not.toContain('mergeReasoningDetails');
    expect(await readDoc('AGENTS.md')).not.toContain('0007-reasoning-details-merge');
    expect(files.cliUx).toContain('model.reasoning');
    expect(files.plan).toContain('ADR-0006');
    expect(files.p15).toContain('状态：Accepted');
    expect(files.testing).toContain('P15_TEST_MATRIX');
    expect(files.testing).toContain('session-text-invariants');
    expect(files.testing).toContain('adapter directly');
    expect(files.testing).toContain('Session `.jsonl`');
    expect(files.plan).toContain('状态：Accepted');
    expect(P1_TEST_MATRIX.every((row) => !row.runtimeEvidence.includes('pending:'))).toBe(true);

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
