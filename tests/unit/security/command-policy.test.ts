import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { PolicyDecision, SafetyMode } from '../../../src/contracts/index.js';
import {
  CentralSafetyPolicy,
  DEFAULT_SAFETY_MODE,
} from '../../../src/security/central-safety-policy.js';

const workspaceRoot = 'C:\\workspace\\echo-fixture';

async function evaluateCommand(
  command: string,
  mode: SafetyMode = DEFAULT_SAFETY_MODE,
  sessionApprovals: ReadonlySet<string> = new Set(),
): Promise<PolicyDecision> {
  return new CentralSafetyPolicy().evaluate({
    mode,
    toolName: 'run_command',
    normalizedInput: { command },
    workspaceRoot,
    sessionApprovals,
  });
}

function approvalKeyFor(command: string): string {
  const digest = createHash('sha256')
    .update(`run_command\0${JSON.stringify({ command })}`)
    .digest('hex')
    .slice(0, 24);
  return `approval:run_command:${digest}`;
}

describe('CentralSafetyPolicy', () => {
  it('uses balanced as the exported default and allows common validation commands', async () => {
    expect(DEFAULT_SAFETY_MODE).toBe('balanced');
    await expect(evaluateCommand('pnpm test')).resolves.toMatchObject({ action: 'allow' });
    await expect(evaluateCommand('git status --short')).resolves.toMatchObject({ action: 'allow' });
    await expect(evaluateCommand('pnpm test', 'safe')).resolves.toMatchObject({ action: 'ask' });
  });

  it('does not let command chaining inherit the first command classification', async () => {
    await expect(evaluateCommand('pnpm test && Write-Output done')).resolves.toMatchObject({
      action: 'ask',
    });
  });

  it.each([
    ['dependency installation', 'pnpm install'],
    ['Git writes', 'git commit -m test'],
    ['network access', 'Invoke-WebRequest https://example.invalid'],
    ['local deletion', "Remove-Item -LiteralPath 'temp.txt'"],
    ['unknown repository scripts', '.\\scripts\\unknown.ps1'],
  ])('asks before %s in every mode', async (_label, command) => {
    for (const mode of ['safe', 'balanced', 'auto'] as const) {
      await expect(evaluateCommand(command, mode)).resolves.toMatchObject({ action: 'ask' });
    }
  });

  it('lets auto approve only explicitly classified local command writes', async () => {
    const command = "Set-Content -LiteralPath 'src/generated.txt' -Value ok";

    await expect(evaluateCommand(command, 'safe')).resolves.toMatchObject({ action: 'ask' });
    await expect(evaluateCommand(command, 'balanced')).resolves.toMatchObject({ action: 'ask' });
    await expect(evaluateCommand(command, 'auto')).resolves.toMatchObject({ action: 'allow' });
  });

  it.each([
    ['workspace escape', "Get-Content 'C:\\outside\\secret.txt'"],
    ['credential access', '[Console]::Write($env:ECHO_API_KEY)'],
    ['environment dump', 'Get-ChildItem Env:'],
    ['privilege escalation', 'Start-Process powershell -Verb RunAs'],
    ['broad destruction', 'Remove-Item -Recurse -Force .'],
    ['encoded policy bypass', 'powershell -EncodedCommand ZQBjAGgAbwA='],
    ['abbreviated encoded policy bypass', 'powershell -enc ZQBjAGgAbwA='],
    ['destructive Git reset', 'git reset --hard'],
    ['system shutdown', 'shutdown.exe /s /t 0'],
    ['registry hive deletion', 'reg.exe delete HKLM\\Software\\Fixture /f'],
  ])('hard-denies %s in every mode', async (_label, command) => {
    for (const mode of ['safe', 'balanced', 'auto'] as const) {
      await expect(evaluateCommand(command, mode)).resolves.toEqual(
        expect.objectContaining({ action: 'deny', hard: true }),
      );
    }
  });

  it('allows every registered-tool request in Full Access without per-operation approval', async () => {
    await expect(evaluateCommand('pnpm install', 'full-access')).resolves.toMatchObject({
      action: 'allow',
      ruleId: 'policy.tool.full_access',
    });
    await expect(
      evaluateCommand('[Console]::Write($env:ECHO_API_KEY)', 'full-access'),
    ).resolves.toMatchObject({ action: 'allow', ruleId: 'policy.tool.full_access' });

    const policy = new CentralSafetyPolicy();
    await expect(
      policy.evaluate({
        mode: 'full-access',
        toolName: 'workspace_extension_tool',
        normalizedInput: { path: '..\\outside.txt' },
        workspaceRoot,
        sessionApprovals: new Set(),
      }),
    ).resolves.toMatchObject({ action: 'allow', ruleId: 'policy.tool.full_access' });
  });

  it('uses a stable, exact approval key without weakening hard-deny rules', async () => {
    const command = 'pnpm install';
    const first = await evaluateCommand(command);
    expect(first.action).toBe('ask');
    if (first.action !== 'ask') throw new Error('Expected an approval request.');

    await expect(
      evaluateCommand(command, 'balanced', new Set([first.approvalKey])),
    ).resolves.toEqual(expect.objectContaining({ action: 'allow' }));

    const changed = await evaluateCommand(
      'pnpm install --offline',
      'balanced',
      new Set([first.approvalKey]),
    );
    expect(changed.action).toBe('ask');
    if (changed.action !== 'ask') throw new Error('Expected a changed operation to ask again.');
    expect(changed.approvalKey).not.toBe(first.approvalKey);

    await expect(
      evaluateCommand('[Console]::Write($env:ECHO_API_KEY)', 'auto', new Set([first.approvalKey])),
    ).resolves.toEqual(expect.objectContaining({ action: 'deny', hard: true }));
  });

  it('applies the shared mode matrix to file tools and rejects path escape', async () => {
    const policy = new CentralSafetyPolicy();
    const request = {
      mode: 'balanced' as const,
      toolName: 'write_file',
      normalizedInput: { path: 'src/generated.ts' },
      workspaceRoot,
      sessionApprovals: new Set<string>(),
    };

    await expect(policy.evaluate(request)).resolves.toMatchObject({ action: 'allow' });
    await expect(policy.evaluate({ ...request, mode: 'safe' })).resolves.toMatchObject({
      action: 'ask',
    });
    await expect(
      policy.evaluate({ ...request, normalizedInput: { path: '..\\outside.txt' } }),
    ).resolves.toEqual(expect.objectContaining({ action: 'deny', hard: true }));
    await expect(
      policy.evaluate({ ...request, normalizedInput: { path: '.git\\config' } }),
    ).resolves.toEqual(expect.objectContaining({ action: 'deny', hard: true }));
  });

  it.each([
    [
      'a DOS short-name path outside the workspace',
      String.raw`Set-Content -LiteralPath C:\Users\FIXTUR~1\AppData\Local\Temp\escape.txt -Value x`,
    ],
    [
      'an identity-bearing file path outside the workspace',
      String.raw`Get-Content C:\Users\fixture\outside.txt`,
    ],
    ['an identity-bearing path sent to output', String.raw`Write-Output C:\Users\fixture`],
    [
      'a drive-relative path whose location cannot be proven',
      String.raw`Set-Content -LiteralPath C:Users\fixture\escape.txt -Value x`,
    ],
    [
      'a PowerShell environment-variable path',
      String.raw`Set-Content -LiteralPath $env:TEMP\escape.txt -Value x`,
    ],
    ['a PowerShell identity variable sent to output', 'Write-Output $env:USERPROFILE'],
    ['a cmd-style environment-variable path', String.raw`Get-Content %USERPROFILE%\outside.txt`],
    ['an environment-provider path', String.raw`Get-Content (Get-Item Env:TEMP).Value\outside.txt`],
    [
      'a dynamically resolved identity directory',
      "Write-Output ([Environment]::GetFolderPath('UserProfile'))",
    ],
  ])('hard-denies %s in every mode even with an exact prior approval', async (_label, command) => {
    const approvals = new Set([approvalKeyFor(command)]);
    for (const mode of ['safe', 'balanced', 'auto'] as const) {
      await expect(evaluateCommand(command, mode, approvals)).resolves.toEqual(
        expect.objectContaining({ action: 'deny', hard: true }),
      );
    }
  });

  it('hard-denies direct run_command writes to Git internals without changing local write modes', async () => {
    const gitWrite = String.raw`Set-Content -LiteralPath .git\config -Value x`;
    const approval = new Set([approvalKeyFor(gitWrite)]);

    await expect(evaluateCommand(gitWrite, 'auto', approval)).resolves.toEqual(
      expect.objectContaining({ action: 'deny', hard: true }),
    );
    await expect(
      evaluateCommand('Set-Content -LiteralPath (Join-Path .git config) -Value x', 'auto'),
    ).resolves.toEqual(expect.objectContaining({ action: 'deny', hard: true }));
    await expect(
      evaluateCommand(String.raw`Set-Content -LiteralPath src\generated.txt -Value x`, 'auto'),
    ).resolves.toMatchObject({ action: 'allow' });
    await expect(
      evaluateCommand(String.raw`Set-Content -LiteralPath src\generated.txt -Value x`, 'balanced'),
    ).resolves.toMatchObject({ action: 'ask' });
  });

  it.each([
    ['a script block', String.raw`& { Set-Content -LiteralPath .git\config -Value x }`],
    [
      'a conditional block',
      String.raw`if ($true) { Set-Content -LiteralPath .git\config -Value x }`,
    ],
  ])(
    'hard-denies Git-internal writes nested in %s despite an exact approval',
    async (_label, command) => {
      const approvals = new Set([approvalKeyFor(command)]);
      for (const mode of ['safe', 'balanced', 'auto'] as const) {
        await expect(evaluateCommand(command, mode, approvals)).resolves.toEqual(
          expect.objectContaining({ action: 'deny', hard: true }),
        );
      }
    },
  );

  it.each([
    ['Remove-Item alias against dot', 'ri -Recurse -Force .'],
    ['computed workspace root', 'Remove-Item -Recurse -Force (Get-Location)'],
    ['quoted workspace root', "ri -Recurse -Force '.'"],
    ['dot-slash workspace root', 'ri -Recurse -Force .\\'],
    ['location alias', 'ri -Recurse -Force (pwd)'],
    [
      'the absolute workspace root',
      String.raw`Remove-Item -Recurse -Force C:\workspace\echo-fixture`,
    ],
  ])(
    'hard-denies broad deletion through %s even with an exact prior approval',
    async (_label, command) => {
      const approvals = new Set([approvalKeyFor(command)]);
      for (const mode of ['safe', 'balanced', 'auto'] as const) {
        await expect(evaluateCommand(command, mode, approvals)).resolves.toEqual(
          expect.objectContaining({ action: 'deny', hard: true }),
        );
      }
    },
  );
});
