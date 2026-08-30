import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';

const artifactRoot = path.join(os.tmpdir(), 'echo-cli-help-artifact');

describe('CLI metadata', () => {
  it('renders stable help text', () => {
    const cli = createCli({ version: '9.8.7' });
    const help = cli.helpInformation();

    expect(help).toContain('echo-harness');
    expect(help).toContain('ECHO Harness');
    expect(help).toContain('local-first autonomous coding agent');
    expect(help).toContain('run');
    expect(help).toContain('chat');
    expect(help).toContain('config');
    expect(help).toContain('web');
    expect(cli.commands.find((item) => item.name() === 'run')?.helpInformation()).toContain(
      'GET /models',
    );
  });

  it('registers the interactive config command', () => {
    const cli = createCli({ version: '9.8.7', artifactRoot });
    const command = cli.commands.find((item) => item.name() === 'config');
    expect(command?.description()).toContain('echo.config.json');
    expect(command?.description()).toContain('/model');
  });

  it('uses an injected version for deterministic tests', () => {
    const cli = createCli({ version: '9.8.7' });

    expect(cli.version()).toBe('9.8.7');
  });

  it('uses the project version by default', () => {
    const cli = createCli();

    expect(cli.version()).toBe('0.1.0');
  });

  it('parses run options and delegates one turn without embedding agent logic', async () => {
    let exitCode: number | undefined;
    const runAction = vi.fn().mockResolvedValue({ exitCode: 6 });
    const cli = createCli({
      version: '9.8.7',
      artifactRoot,
      runAction,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    await cli.parseAsync([
      'node',
      'echo-harness',
      'run',
      'fix tests',
      '--workspace',
      '.',
      '--model',
      'fake-model',
      '--safety-mode',
      'safe',
      '--max-steps',
      '7',
      '--verbose',
      '--non-interactive',
      '--no-color',
    ]);

    expect(runAction).toHaveBeenCalledWith(
      'fix tests',
      expect.objectContaining({
        workspace: '.',
        model: 'fake-model',
        safetyMode: 'safe',
        maxSteps: 7,
        verbose: true,
        interactive: false,
        color: false,
        artifactRoot,
      }),
    );
    expect(exitCode).toBe(6);
  });

  it('parses chat options and delegates without embedding agent logic', async () => {
    let exitCode: number | undefined;
    const chatAction = vi.fn().mockResolvedValue({ exitCode: 130 });
    const cli = createCli({
      version: '9.8.7',
      artifactRoot,
      chatAction,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    await cli.parseAsync([
      'node',
      'echo-harness',
      'chat',
      '--workspace',
      '.',
      '--resume',
      'session-demo',
      '--model',
      'fake-model',
      '--safety-mode',
      'safe',
      '--no-color',
    ]);

    expect(chatAction).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: '.',
        resume: 'session-demo',
        model: 'fake-model',
        safetyMode: 'safe',
        color: false,
        artifactRoot,
      }),
    );
    expect(exitCode).toBe(130);
  });

  it('parses web options and delegates without embedding HTTP routes', async () => {
    let exitCode: number | undefined;
    const webAction = vi.fn().mockResolvedValue({ exitCode: 0 });
    const cli = createCli({
      version: '9.8.7',
      artifactRoot,
      webAction,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    await cli.parseAsync([
      'node',
      'echo-harness',
      'web',
      '--workspace',
      '.',
      '--port',
      '0',
      '--no-open',
    ]);

    expect(webAction).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: '.',
        port: 0,
        artifactRoot,
      }),
    );
    expect(exitCode).toBe(0);
  });

  it('throws a Commander error for missing run arguments instead of exiting the host process', async () => {
    const cli = createCli();
    cli.commands
      .find((command) => command.name() === 'run')
      ?.configureOutput({
        writeErr: () => undefined,
      });

    await expect(cli.parseAsync(['node', 'echo-harness', 'run'])).rejects.toMatchObject({
      code: 'commander.missingArgument',
      exitCode: 1,
    });
  });
});
