import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tempDirs: string[] = [];

const POSITIVE_SECRETS = {
  'openai-key': ['sk-', 'testpos_', 'abcdefghijklmnopqrstuvwxyz012345'].join(''),
  'github-token': ['ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join(''),
  'aws-access-key': ['AKIA', 'TESTPOSITIVE0001'].join(''),
  'private-key': [
    '-----BEGIN ',
    'RSA PRIVATE KEY-----\nMIIBOgPLACEHOLDER\n-----END RSA PRIVATE KEY-----',
  ].join(''),
  'assigned-secret': ['client_secret=', 'abcdefghijklmnopqrstuvwxyz0123'].join(''),
} as const;

const POSITIVE_IDENTITY = {
  email: ['alice.zhang.eval', '@', 'gmail.com'].join(''),
  'windows-profile': ['C:\\Users\\', 'ZhangWei', '\\Documents\\notes.txt'].join(''),
} as const;

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runScript(
  scriptName: string,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', scriptName), ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function expectNoLeak(output: string, secrets: readonly string[]): void {
  const lower = output.toLocaleLowerCase('en-US');
  for (const secret of secrets) {
    expect(lower).not.toContain(secret.toLocaleLowerCase('en-US'));
  }
  expect(output).not.toContain(os.homedir());
  expect(output).not.toMatch(/[A-Za-z]:\\Users\\ZhangWei/iu);
}

describe('secret and identity scanners', () => {
  it('flags known malicious secret samples without printing the secret values', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'echo-scan-secret-pos-'));
    tempDirs.push(directory);
    const planted = Object.values(POSITIVE_SECRETS);
    await writeFile(path.join(directory, 'leak.txt'), `${planted.join('\n')}\n`, 'utf8');

    const result = runScript('scan-secrets.mjs', ['--root', directory]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('secret-scan:');
    expect(result.stdout).toContain('rule=openai-key');
    expect(result.stdout).toContain('rule=github-token');
    expect(result.stdout).toContain('rule=aws-access-key');
    expect(result.stdout).toContain('rule=private-key');
    expect(result.stdout).toContain('rule=assigned-secret');
    expectNoLeak(result.stdout, planted);
  });

  it('does not flag public placeholder configuration or documentation samples', () => {
    const negativeRoot = path.join(
      repoRoot,
      'tests',
      'evals',
      'scan-samples',
      'secrets',
      'negative',
    );
    const result = runScript('scan-secrets.mjs', ['--root', negativeRoot]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('secret-scan: passed');
    expectNoLeak(result.stdout, Object.values(POSITIVE_SECRETS));
  });

  it('flags identity-bearing emails and profile paths but ignores documented fixtures', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'echo-scan-id-pos-'));
    tempDirs.push(directory);
    const planted = Object.values(POSITIVE_IDENTITY);
    await writeFile(path.join(directory, 'identity.txt'), `${planted.join('\n')}\n`, 'utf8');

    const positive = runScript('scan-identity.mjs', ['--root', directory]);
    expect(positive.status).toBe(1);
    expect(positive.stdout).toContain('rule=email');
    expect(positive.stdout).toContain('rule=windows-profile');
    expectNoLeak(positive.stdout, planted);

    const negativeRoot = path.join(
      repoRoot,
      'tests',
      'evals',
      'scan-samples',
      'identity',
      'negative',
    );
    const negative = runScript('scan-identity.mjs', ['--root', negativeRoot]);
    expect(negative.status).toBe(0);
    expect(negative.stdout).toContain('identity-scan: passed');
  });

  it('runs CLI self-tests and a clean repo scan without leaking secrets or personal paths', () => {
    const secretsCli = runScript('scan-secrets.mjs', []);
    const identityCli = runScript('scan-identity.mjs', []);
    const secretsSelfCli = runScript('scan-secrets.mjs', ['--self-test']);
    const identitySelfCli = runScript('scan-identity.mjs', ['--self-test']);
    const combined = `${secretsCli.stdout}${identityCli.stdout}${secretsSelfCli.stdout}${identitySelfCli.stdout}`;

    expect(secretsCli.status).toBe(0);
    expect(identityCli.status).toBe(0);
    expect(secretsSelfCli.status).toBe(0);
    expect(identitySelfCli.status).toBe(0);
    expect(secretsCli.stdout).toContain('secret-scan: passed');
    expect(identityCli.stdout).toContain('identity-scan: passed');
    expect(secretsSelfCli.stdout).toContain('secret-scan self-test: passed');
    expect(identitySelfCli.stdout).toContain('identity-scan self-test: passed');
    expectNoLeak(combined, [
      ...Object.values(POSITIVE_SECRETS),
      ...Object.values(POSITIVE_IDENTITY),
    ]);
  });
});
