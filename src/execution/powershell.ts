import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { BoundedTextBuffer } from './bounded-text-buffer.js';
import { discoverPowerShellExecutable } from './discover-powershell.js';

const CHILD_ENVIRONMENT_ALLOWLIST = new Set(
  [
    'APPDATA',
    'COMSPEC',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATH',
    'PATHEXT',
    'PNPM_HOME',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'USERNAME',
    'COMPUTERNAME',
    'WINDIR',
  ].map((name) => name.toUpperCase()),
);

export type PowerShellTerminationReason = 'exited' | 'timeout' | 'cancelled' | 'spawn_error';

export interface PowerShellExecutionOptions {
  readonly command: string;
  readonly workspaceRoot: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly signal: AbortSignal;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Controlled host configuration only; never populate this from model input. */
  readonly executable?: string;
}

export interface PowerShellExecutionResult {
  readonly reason: PowerShellTerminationReason;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutOriginalChars: number;
  readonly stderrOriginalChars: number;
  readonly durationMs: number;
  readonly terminationAttempted: boolean;
  readonly terminationSucceeded: boolean;
  readonly errorMessage?: string;
}

const UTF8_COMMAND_PREFIX =
  '$ProgressPreference = "SilentlyContinue"; ' +
  '$ConfirmPreference = "None"; ' +
  '$echoUtf8 = [System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding = $echoUtf8; ' +
  '$echoStdOut = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $echoUtf8); ' +
  '$echoStdOut.AutoFlush = $true; ' +
  '[Console]::SetOut($echoStdOut); ' +
  '$echoStdErr = [System.IO.StreamWriter]::new([Console]::OpenStandardError(), $echoUtf8); ' +
  '$echoStdErr.AutoFlush = $true; ' +
  '[Console]::SetError($echoStdErr); ';

export function buildPowerShellArguments(command: string): readonly string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-InputFormat',
    'Text',
    '-OutputFormat',
    'Text',
    '-Command',
    UTF8_COMMAND_PREFIX + command,
  ];
}

export function sanitizeChildEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

export function buildChildEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const sanitized = sanitizeChildEnvironment(source);
  const systemRoot = sanitized.SYSTEMROOT ?? sanitized.WINDIR;
  if (systemRoot !== undefined && systemRoot.trim().length > 0) {
    sanitized.PSModulePath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  }
  return sanitized;
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const resolved = await realpath(workspaceRoot);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) {
    throw new Error('The configured workspace root is not a directory.');
  }
  return resolved;
}

async function terminateWindowsProcessTree(processId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
      env: sanitizeChildEnvironment(process.env),
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(succeeded);
    };
    const timeout = setTimeout(() => {
      killer.kill();
      finish(false);
    }, 2_000);
    timeout.unref();
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
}

async function terminatePosixProcessTree(processId: number): Promise<boolean> {
  try {
    process.kill(-processId, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(processId, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

async function terminateProcessTree(processId: number): Promise<boolean> {
  return process.platform === 'win32'
    ? terminateWindowsProcessTree(processId)
    : terminatePosixProcessTree(processId);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function preStartResult(
  reason: 'cancelled' | 'spawn_error',
  startedAt: number,
  errorMessage?: string,
): PowerShellExecutionResult {
  return {
    reason,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutOriginalChars: 0,
    stderrOriginalChars: 0,
    durationMs: elapsedMilliseconds(startedAt),
    terminationAttempted: false,
    terminationSucceeded: false,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

export async function executePowerShell(
  options: PowerShellExecutionOptions,
): Promise<PowerShellExecutionResult> {
  const startedAt = performance.now();
  if (options.signal.aborted) return preStartResult('cancelled', startedAt);

  let workspaceRoot: string;
  try {
    workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to resolve the workspace root.';
    return preStartResult('spawn_error', startedAt, message);
  }
  if (options.signal.aborted) return preStartResult('cancelled', startedAt);

  let executable: string;
  try {
    executable =
      options.executable ?? (await discoverPowerShellExecutable(options.env ?? process.env));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to discover PowerShell.';
    return preStartResult('spawn_error', startedAt, message);
  }
  if (options.signal.aborted) return preStartResult('cancelled', startedAt);

  const stdout = new BoundedTextBuffer(options.maxOutputChars);
  const stderr = new BoundedTextBuffer(options.maxOutputChars);

  return new Promise((resolve) => {
    const child = spawn(executable, buildPowerShellArguments(options.command), {
      cwd: workspaceRoot,
      detached: process.platform !== 'win32',
      env: buildChildEnvironment(options.env ?? process.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.append(chunk));
    child.stderr.on('data', (chunk: string) => stderr.append(chunk));

    let finishing = false;
    let terminationReason: 'timeout' | 'cancelled' | undefined;
    let terminationAttempted = false;
    let terminationResult: Promise<boolean> | undefined;
    let fallbackTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      options.signal.removeEventListener('abort', abortListener);
    };

    const finish = async (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
      spawnError?: Error,
    ): Promise<void> => {
      if (finishing) return;
      finishing = true;
      cleanup();
      const terminationSucceeded =
        terminationResult === undefined ? false : await terminationResult;
      const stdoutResult = stdout.finish();
      const stderrResult = stderr.finish();
      const reason = spawnError === undefined ? (terminationReason ?? 'exited') : 'spawn_error';
      resolve({
        reason,
        exitCode: reason === 'exited' ? exitCode : null,
        signal: exitSignal,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
        stdoutOriginalChars: stdoutResult.originalChars,
        stderrOriginalChars: stderrResult.originalChars,
        durationMs: elapsedMilliseconds(startedAt),
        terminationAttempted,
        terminationSucceeded,
        ...(spawnError === undefined ? {} : { errorMessage: spawnError.message }),
      });
    };

    const requestTermination = (reason: 'timeout' | 'cancelled'): void => {
      if (terminationReason !== undefined || finishing) return;
      terminationReason = reason;
      terminationAttempted = true;
      if (child.pid === undefined) {
        void finish(null, null);
        return;
      }
      terminationResult = terminateProcessTree(child.pid);
      void terminationResult.then(() => {
        if (!finishing) child.kill('SIGKILL');
      });
      fallbackTimer = setTimeout(() => void finish(null, null), 3_000);
      fallbackTimer.unref();
    };

    const abortListener = (): void => requestTermination('cancelled');
    options.signal.addEventListener('abort', abortListener, { once: true });
    const timeoutTimer = setTimeout(() => requestTermination('timeout'), options.timeoutMs);
    timeoutTimer.unref();

    child.once('error', (error) => void finish(null, null, error));
    child.once('close', (exitCode, exitSignal) => void finish(exitCode, exitSignal));

    if (options.signal.aborted) requestTermination('cancelled');
  });
}
