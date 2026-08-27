import { describe, expect, it } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';

describe('CLI metadata', () => {
  it('renders stable help text', () => {
    const cli = createCli({ version: '9.8.7' });
    const help = cli.helpInformation();

    expect(help).toContain('echo-harness');
    expect(help).toContain('ECHO Harness');
    expect(help).toContain('local-first autonomous coding agent');
  });

  it('uses an injected version for deterministic tests', () => {
    const cli = createCli({ version: '9.8.7' });

    expect(cli.version()).toBe('9.8.7');
  });

  it('uses the project version by default', () => {
    const cli = createCli();

    expect(cli.version()).toBe('0.1.0');
  });
});
