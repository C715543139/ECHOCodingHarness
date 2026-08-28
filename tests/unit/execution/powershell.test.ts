import { afterEach, describe, expect, it } from 'vitest';

import { BoundedTextBuffer } from '../../../src/execution/bounded-text-buffer.js';
import {
  buildControlledPowerShellExecutablePath,
  discoverPowerShellExecutable,
  resetDiscoveredPowerShellExecutableForTests,
} from '../../../src/execution/discover-powershell.js';
import {
  buildPowerShellArguments,
  sanitizeChildEnvironment,
} from '../../../src/execution/powershell.js';

describe('PowerShell execution helpers', () => {
  afterEach(() => {
    resetDiscoveredPowerShellExecutableForTests();
  });

  it('passes the command as one argument behind all non-interactive boundaries', () => {
    const command = "Write-Output 'value with spaces'; Write-Output '--NoProfile'";
    const arguments_ = buildPowerShellArguments(command);

    expect(arguments_.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]);
    expect(arguments_).toHaveLength(5);
    expect(arguments_[4]).toMatch(/OutputEncoding/u);
    expect(arguments_[4]).toMatch(/Write-Output 'value with spaces'; Write-Output '--NoProfile'$/u);
  });

  it('builds an allowlisted environment and removes credentials case-insensitively', () => {
    const sanitized = sanitizeChildEnvironment({
      Path: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      ECHO_API_KEY: 'echo-secret',
      echo_api_key: 'lower-secret',
      GITHUB_TOKEN: 'github-secret',
      NPM_TOKEN: 'npm-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      CUSTOM_VALUE: 'must-not-pass',
    });

    expect(sanitized).toMatchObject({
      Path: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\Temp',
    });
    expect(Object.keys(sanitized).map((key) => key.toUpperCase())).not.toEqual(
      expect.arrayContaining([
        'ECHO_API_KEY',
        'GITHUB_TOKEN',
        'NPM_TOKEN',
        'AWS_SECRET_ACCESS_KEY',
        'CUSTOM_VALUE',
      ]),
    );
  });

  it('keeps bounded head and tail output with an explicit truncation marker', () => {
    const buffer = new BoundedTextBuffer(80);
    buffer.append('HEAD-' + 'x'.repeat(120));
    buffer.append('-TAIL');
    const result = buffer.finish();

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(80);
    expect(result.text).toMatch(/^HEAD-/u);
    expect(result.text).toMatch(/-TAIL$/u);
    expect(result.text).toContain('truncated');
    expect(result.originalChars).toBe(130);
  });

  it('targets the canonical WindowsPowerShell host instead of a PATH lookup', () => {
    const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows';
    const discoveredPath = buildControlledPowerShellExecutablePath(systemRoot);

    expect(discoveredPath).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu);
    expect(discoveredPath).not.toMatch(/System32[\\/]powershell\.exe$/iu);
  });

  it('discovers the installed Windows PowerShell host on Windows', async () => {
    if (process.platform !== 'win32') return;

    const discovered = await discoverPowerShellExecutable();
    expect(discovered).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu);
    expect(discovered).not.toMatch(/System32[\\/]powershell\.exe$/iu);
  });
});
