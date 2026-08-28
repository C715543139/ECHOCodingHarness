import { describe, expect, it, vi } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';

describe('CLI metadata', () => {
  it('renders stable help text', () => {
    const cli = createCli({ version: '9.8.7' });
    const help = cli.helpInformation();

    expect(help).toContain('echo-harness');
    expect(help).toContain('ECHO Harness');
    expect(help).toContain('local-first autonomous coding agent');
    expect(help).toContain('run');
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
      }),
    );
    expect(exitCode).toBe(6);
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
