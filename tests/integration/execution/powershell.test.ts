import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverPowerShellExecutable } from '../../../src/execution/discover-powershell.js';
import { executePowerShell } from '../../../src/execution/powershell.js';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const workspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'echo command 空格 '));
  workspaces.push(workspace);
  return workspace;
}

async function makeAsciiWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'echo-command-ascii-'));
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, {
        force: true,
        maxRetries: 10,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

describeWindows('executePowerShell on Windows', () => {
  it('discovers the canonical WindowsPowerShell host before spawning', async () => {
    const discovered = await discoverPowerShellExecutable();
    expect(discovered).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu);
    expect(discovered).not.toMatch(/System32[\\/]powershell\.exe$/iu);
  });

  it('uses a fixed cwd and preserves Chinese text and spaced arguments', async () => {
    const workspaceRoot = await makeWorkspace();
    const result = await executePowerShell({
      command:
        '$echoCwd = [System.IO.Directory]::GetCurrentDirectory(); ' +
        "$echoPath = [System.IO.Path]::Combine($echoCwd, '带 空格.txt'); " +
        '[System.IO.File]::WriteAllText($echoPath, "中文 内容", $echoUtf8); ' +
        '[Console]::Out.Write([System.IO.File]::ReadAllText($echoPath, $echoUtf8)); ' +
        "[Console]::Error.Write('警告 信息')",
      env: process.env,
      maxOutputChars: 1_000,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workspaceRoot,
    });

    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('中文 内容');
    expect(result.stderr).toBe('警告 信息');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    await expect(readFile(join(workspaceRoot, '带 空格.txt'), 'utf8')).resolves.toBe('中文 内容');
  });

  it('runs Set-Content and Get-Content in an ASCII workspace', async () => {
    const workspaceRoot = await makeAsciiWorkspace();
    const result = await executePowerShell({
      command:
        "Set-Content -LiteralPath 'hello.txt' -Value 'ascii content' -NoNewline; " +
        "[Console]::Out.Write((Get-Content -Raw -LiteralPath 'hello.txt')); " +
        "[Console]::Error.Write('cmdlet ok')",
      env: process.env,
      maxOutputChars: 1_000,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workspaceRoot,
    });

    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ascii content');
    expect(result.stderr).toBe('cmdlet ok');
  });

  it('keeps a non-zero exit code and separate stderr as execution facts', async () => {
    const result = await executePowerShell({
      command: "[Console]::Out.Write('before'); [Console]::Error.Write('failed'); exit 7",
      env: process.env,
      maxOutputChars: 1_000,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workspaceRoot: await makeWorkspace(),
    });

    expect(result).toMatchObject({
      exitCode: 7,
      reason: 'exited',
      stderr: 'failed',
      stdout: 'before',
    });
  });

  it('bounds stdout and preserves its head and tail', async () => {
    const result = await executePowerShell({
      command: "[Console]::Out.Write('HEAD-' + ('x' * 2000) + '-TAIL')",
      env: process.env,
      maxOutputChars: 120,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workspaceRoot: await makeWorkspace(),
    });

    expect(result.stdout.length).toBeLessThanOrEqual(120);
    expect(result.stdout).toMatch(/^HEAD-/u);
    expect(result.stdout).toMatch(/-TAIL$/u);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutOriginalChars).toBe(2_010);
  });

  it('applies a separate bound and metadata to stderr', async () => {
    const result = await executePowerShell({
      command: "[Console]::Error.Write('ERROR-' + ('y' * 2000) + '-END')",
      env: process.env,
      maxOutputChars: 100,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workspaceRoot: await makeWorkspace(),
    });

    expect(result.stderr.length).toBeLessThanOrEqual(100);
    expect(result.stderr).toMatch(/^ERROR-/u);
    expect(result.stderr).toMatch(/-END$/u);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderrOriginalChars).toBe(2_010);
    expect(result.stdoutTruncated).toBe(false);
  });

  it('times out and terminates the complete PowerShell process tree', async () => {
    const result = await executePowerShell({
      command:
        '$start = [System.Diagnostics.ProcessStartInfo]::new(); ' +
        "$start.FileName = 'cmd.exe'; " +
        "$start.Arguments = '/d /c ping -n 30 127.0.0.1 >nul'; " +
        '$start.CreateNoWindow = $true; ' +
        '$start.UseShellExecute = $false; ' +
        '$child = [System.Diagnostics.Process]::Start($start); ' +
        '[Console]::Out.WriteLine($child.Id); [Console]::Out.Flush(); $child.WaitForExit()',
      env: process.env,
      maxOutputChars: 1_000,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      workspaceRoot: await makeWorkspace(),
    });

    expect(result.reason).toBe('timeout');
    expect(result.terminationAttempted).toBe(true);
    expect(result.terminationSucceeded).toBe(true);
    const childPid = Number.parseInt(result.stdout, 10);
    expect(childPid).toBeGreaterThan(0);
    await delay(100);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('honors AbortSignal and terminates an in-flight command', async () => {
    const controller = new AbortController();
    const pending = executePowerShell({
      command: 'Start-Sleep -Seconds 30',
      env: process.env,
      maxOutputChars: 1_000,
      signal: controller.signal,
      timeoutMs: 5_000,
      workspaceRoot: await makeWorkspace(),
    });
    setTimeout(() => controller.abort(), 100);

    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        reason: 'cancelled',
        terminationAttempted: true,
        terminationSucceeded: true,
      }),
    );
  });

  it('does not expose ECHO_API_KEY or unrelated credentials to the child', async () => {
    const result = await executePowerShell({
      command: '[Console]::Out.Write("$env:ECHO_API_KEY|$env:GITHUB_TOKEN|$env:CUSTOM_SECRET")',
      env: {
        ...process.env,
        CUSTOM_SECRET: 'custom-secret',
        ECHO_API_KEY: 'echo-secret',
        GITHUB_TOKEN: 'github-secret',
      },
      maxOutputChars: 1_000,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workspaceRoot: await makeWorkspace(),
    });

    expect(result.stdout).toBe('||');
    expect(result.stdout).not.toContain('secret');
  });

  it('keeps the child PSModulePath on the system modules directory', async () => {
    const result = await executePowerShell({
      command:
        '$hasDocuments = [bool]($env:PSModulePath -like "*Documents\\WindowsPowerShell\\Modules*"); ' +
        '$hasSystem = [bool]($env:PSModulePath -like "*System32\\WindowsPowerShell\\v1.0\\Modules*"); ' +
        '$count = @($env:PSModulePath -split ";" | Where-Object { $_.Trim().Length -gt 0 }).Count; ' +
        '[Console]::Out.Write("documents=$hasDocuments;system=$hasSystem;count=$count")',
      env: process.env,
      maxOutputChars: 1_000,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workspaceRoot: await makeAsciiWorkspace(),
    });

    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('documents=False;system=True;count=1');
    expect(result.stdout).not.toMatch(/[:\\/]/u);
  });

  it('returns a structured spawn error when the controlled executable is unavailable', async () => {
    const result = await executePowerShell({
      command: 'Write-Output never',
      env: process.env,
      executable: 'echo-harness-missing-powershell.exe',
      maxOutputChars: 1_000,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      workspaceRoot: await makeWorkspace(),
    });

    expect(result).toEqual(
      expect.objectContaining({
        exitCode: null,
        reason: 'spawn_error',
        terminationAttempted: false,
      }),
    );
    expect(result.errorMessage).toBeTruthy();
  });
});
