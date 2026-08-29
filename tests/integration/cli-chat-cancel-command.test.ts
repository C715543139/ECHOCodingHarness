import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ScriptedChatInput } from '../../src/cli/chat-input-reader.js';
import { runChat } from '../../src/cli/chat.js';
import { isToolTerminalEvent, type EchoEvent } from '../../src/contracts/index.js';
import { FakeProvider } from '../../src/provider/index.js';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const temporaryDirectories: string[] = [];
const trackedPids = new Set<number>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function waitForPidFile(filePath: string, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const parsed = Number.parseInt((await fs.readFile(filePath, 'utf8')).trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    } catch {
      // The command has not created the pid file yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-cli-chat-cancel-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeArtifactConfig(artifactRoot: string): Promise<void> {
  await fs.mkdir(path.join(artifactRoot, '.echo', 'config'), { recursive: true });
  await fs.writeFile(
    path.join(artifactRoot, '.echo', 'config', 'echo.config.json'),
    JSON.stringify({
      baseUrl: 'https://provider.example/v1',
      model: 'fake-model',
      modelCatalog: { source: 'manual', models: ['fake-model'] },
      safetyMode: 'balanced',
    }),
    'utf8',
  );
}

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function readEvents(root: string): Promise<EchoEvent[]> {
  const files = await fs.readdir(path.join(root, '.echo', 'sessions'));
  const log = await fs.readFile(path.join(root, '.echo', 'sessions', files[0] as string), 'utf8');
  return log
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EchoEvent);
}

afterEach(async () => {
  for (const pid of trackedPids) {
    killProcessTree(pid);
  }
  trackedPids.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describeWindows('CLI chat cancels an in-flight PowerShell process tree', () => {
  it(
    'interrupts a running run_command, kills the child tree, and returns to the Chat prompt',
    { timeout: 25_000 },
    async () => {
      const root = await workspace();
      await writeArtifactConfig(root);
      const parentPidPath = path.join(root, 'echo-parent.pid');
      const childPidPath = path.join(root, 'echo-child.pid');
      const command = [
        `$parentPath = Join-Path (Get-Location) 'echo-parent.pid'`,
        `$childPath = Join-Path (Get-Location) 'echo-child.pid'`,
        `[System.IO.File]::WriteAllText($parentPath, [string]$PID)`,
        '$start = [System.Diagnostics.ProcessStartInfo]::new()',
        "$start.FileName = 'cmd.exe'",
        "$start.Arguments = '/d /c ping -n 60 127.0.0.1 >nul'",
        '$start.CreateNoWindow = $true',
        '$start.UseShellExecute = $false',
        '$child = [System.Diagnostics.Process]::Start($start)',
        '[System.IO.File]::WriteAllText($childPath, [string]$child.Id)',
        '[Console]::Out.WriteLine($child.Id)',
        '[Console]::Out.Flush()',
        '$child.WaitForExit()',
      ].join('; ');
      const provider = new FakeProvider([
        {
          events: [
            {
              type: 'tool_call',
              call: {
                id: 'call-long-command',
                name: 'run_command',
                arguments: { command },
              },
            },
            { type: 'completed', finishReason: 'tool_calls' },
          ],
        },
      ]);
      let fire: (() => void) | undefined;
      const captured = output();
      const running = runChat(
        {
          workspace: root,
          verbose: false,
          color: false,
          interactive: false,
        },
        {
          env: { ECHO_API_KEY: 'test-key' },
          io: captured.io,
          providerFactory: () => provider,
          approvalHandler: {
            requestApproval: async () => 'once',
          },
          input: new ScriptedChatInput([
            { kind: 'batch', text: 'run a long command', source: 'typed' },
            { kind: 'batch', text: '/quit', source: 'typed' },
          ]),
          attachInterrupt: (handler) => {
            fire = handler;
            return () => {
              fire = undefined;
            };
          },
        },
      );

      let parentPid = 0;
      let childPid = 0;
      try {
        parentPid = await waitForPidFile(parentPidPath, 10_000);
        childPid = await waitForPidFile(childPidPath, 10_000);
        trackedPids.add(parentPid);
        trackedPids.add(childPid);
        expect(processAlive(parentPid)).toBe(true);
        expect(processAlive(childPid)).toBe(true);
        expect(fire).toBeTypeOf('function');
        fire?.();

        const outcome = await running;
        await delay(150);

        expect(outcome.exitCode).toBe(0);
        expect(processAlive(parentPid)).toBe(false);
        expect(processAlive(childPid)).toBe(false);
        expect(captured.stderr()).toContain('TOOL');
        expect(captured.stderr()).toContain('run_command');
        expect(captured.stderr()).toContain('Turn cancelled');
        expect(captured.stderr()).toContain('YOU >');

        const events = await readEvents(root);
        const requested = events.filter((event) => event.type === 'tool.requested');
        const terminals = events.filter((event) => isToolTerminalEvent(event));
        const cancelledTools = events.filter((event) => event.type === 'tool.cancelled');
        const turnCancelled = events.filter((event) => event.type === 'turn.cancelled');

        expect(requested).toHaveLength(1);
        expect(requested[0]?.payload.call.id).toBe('call-long-command');
        expect(requested[0]?.payload.call.name).toBe('run_command');
        expect(terminals).toHaveLength(1);
        expect(cancelledTools).toHaveLength(1);
        expect(cancelledTools[0]?.payload.result.toolCallId).toBe('call-long-command');
        expect(cancelledTools[0]?.payload.phase).toBe('execution');
        expect(turnCancelled).toHaveLength(1);
        expect(turnCancelled[0]?.payload.result.status).toBe('cancelled');
        expect(turnCancelled[0]?.payload.result.stopReason).toBe('cancelled');
        expect(events.some((event) => event.type === 'turn.completed')).toBe(false);
        expect(
          requested.every((event) =>
            terminals.some(
              (terminal) => terminal.payload.result.toolCallId === event.payload.call.id,
            ),
          ),
        ).toBe(true);
      } finally {
        killProcessTree(parentPid);
        killProcessTree(childPid);
        trackedPids.delete(parentPid);
        trackedPids.delete(childPid);
      }
    },
  );
});
