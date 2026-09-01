import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- no project-owned declaration for scripts/*.mjs
import * as isolatedArtifactSmoke from '../../../scripts/smoke-web-isolated-artifact.mjs';

const {
  buildIsolatedPnpmEnv,
  buildIsolatedWebEnv,
  buildPnpmSpawnInvocation,
  isolatedPublishConfig,
  ISOLATED_WEB_SMOKE_KEY,
  resolvePnpmExecutable,
} = isolatedArtifactSmoke;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SENTINEL_ECHO_KEY = ['parent-', 'echo-api-key-', 'sentinel-0001'].join('');
const SENTINEL_ECHO_URL = ['https://', 'secret.example', '/v1'].join('');
const SENTINEL_GITHUB = ['ghp_', 'SENTINELCHILDENV00000000000000000001'].join('');
const SENTINEL_AWS = ['aws-', 'secret-access-key-', 'sentinel-0001'].join('');
const SENTINEL_NPM = ['npm-', 'token-sentinel-value-0001'].join('');
const SENTINEL_OPENAI = ['sk-', 'testpos_', 'childenvsentinel00000001'].join('');
const SENTINEL_CUSTOM = ['must-not-pass-custom-secret-0001'].join('');

function parentEnvWithSentinels(): NodeJS.ProcessEnv {
  return {
    Path: 'C:\\Windows\\System32',
    SYSTEMROOT: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    ECHO_API_KEY: SENTINEL_ECHO_KEY,
    ECHO_BASE_URL: SENTINEL_ECHO_URL,
    echo_api_key: SENTINEL_ECHO_KEY,
    GITHUB_TOKEN: SENTINEL_GITHUB,
    AWS_SECRET_ACCESS_KEY: SENTINEL_AWS,
    NPM_TOKEN: SENTINEL_NPM,
    OPENAI_API_KEY: SENTINEL_OPENAI,
    AZURE_CLIENT_SECRET: SENTINEL_CUSTOM,
    CUSTOM_SECRET: SENTINEL_CUSTOM,
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    NODE_PATH: 'C:\\leaked-modules',
  };
}

const SENTINELS = [
  SENTINEL_ECHO_KEY,
  SENTINEL_ECHO_URL,
  SENTINEL_GITHUB,
  SENTINEL_AWS,
  SENTINEL_NPM,
  SENTINEL_OPENAI,
  SENTINEL_CUSTOM,
] as const;

function envValues(env: NodeJS.ProcessEnv): readonly string[] {
  return Object.values(env).filter((value): value is string => value !== undefined);
}

function envKeysUpper(env: NodeJS.ProcessEnv): readonly string[] {
  return Object.keys(env).map((key) => key.toUpperCase());
}

describe('smoke-web-isolated-artifact env allowlist', () => {
  it('does not copy parent sentinel secrets into pnpm or Web child env', () => {
    const parent = parentEnvWithSentinels();
    const pnpmEnv = buildIsolatedPnpmEnv(parent) as NodeJS.ProcessEnv;
    const webEnv = buildIsolatedWebEnv(parent, ISOLATED_WEB_SMOKE_KEY) as NodeJS.ProcessEnv;

    for (const env of [pnpmEnv, webEnv]) {
      const values = envValues(env);
      for (const sentinel of SENTINELS) {
        expect(values).not.toContain(sentinel);
      }
      const keys = envKeysUpper(env);
      expect(keys).not.toEqual(
        expect.arrayContaining([
          'ECHO_BASE_URL',
          'GITHUB_TOKEN',
          'AWS_SECRET_ACCESS_KEY',
          'NPM_TOKEN',
          'OPENAI_API_KEY',
          'AZURE_CLIENT_SECRET',
          'CUSTOM_SECRET',
          'CI',
          'GITHUB_ACTIONS',
          'NODE_PATH',
        ]),
      );
    }

    expect(pnpmEnv.ECHO_API_KEY).toBeUndefined();
    expect(webEnv.ECHO_API_KEY).toBe(ISOLATED_WEB_SMOKE_KEY);
    expect(webEnv.ECHO_API_KEY).not.toBe(SENTINEL_ECHO_KEY);
    expect(pnpmEnv.Path).toBe('C:\\Windows\\System32');
    expect(webEnv.SYSTEMROOT).toBe('C:\\Windows');
    expect(pnpmEnv.npm_config_link_workspace_packages).toBe('false');
    expect(webEnv.NO_COLOR).toBe('1');
  });

  it('keeps isolated publish config and smoke key out of each other', () => {
    const serialized = JSON.stringify(isolatedPublishConfig());
    expect(serialized).not.toContain(ISOLATED_WEB_SMOKE_KEY);
    for (const sentinel of SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).not.toMatch(/apiKey|ECHO_API_KEY|secret/iu);
  });

  it('resolves Windows pnpm without a shell and keeps the command name stable', () => {
    const parent = parentEnvWithSentinels();
    const executable = resolvePnpmExecutable(parent) as string;
    const invocation = buildPnpmSpawnInvocation(
      ['install', '--prod', '--offline', '--store-dir', 'F:\\.pnpm-store\\v11'],
      parent,
    ) as {
      readonly command: string;
      readonly args: readonly string[];
      readonly shell: boolean;
    };
    expect(invocation.shell).toBe(false);
    const serialized = JSON.stringify(invocation);
    for (const sentinel of SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
    if (process.platform === 'win32') {
      expect(executable.toLocaleLowerCase('en-US')).toMatch(/pnpm\.cmd$/u);
      expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(invocation.args[3]).toMatch(/pnpm\.cmd/iu);
      expect(invocation.args[3]).toContain('--prod');
      expect(invocation.args[3]).toContain('--offline');
    } else {
      expect(executable).toBe('pnpm');
      expect(invocation.command).toBe('pnpm');
      expect(invocation.args).toEqual([
        'install',
        '--prod',
        '--offline',
        '--store-dir',
        'F:\\.pnpm-store\\v11',
      ]);
    }
  });
});

describe('smoke-web-isolated-artifact source contract', () => {
  it('copies a minimal dist package to a temp tree and never uses repo node_modules or .env.test', async () => {
    const source = await fs.readFile(
      path.join(ROOT, 'scripts', 'smoke-web-isolated-artifact.mjs'),
      'utf8',
    );

    expect(source).toContain('echo-web-isolated-');
    expect(source).toContain('packageDir');
    expect(source).toContain("web', '--no-open'");
    expect(source).toContain('127.0.0.1');
    expect(source).toContain('/api/v1/auth/bootstrap');
    expect(source).toContain('/api/v1/bootstrap');
    expect(source).toContain('/api/v1/sessions');
    expect(source).toContain('expected 201');
    expect(source).toContain('SessionView DTO');
    expect(source).not.toContain('pending-wiring');
    expect(source).toContain('stdin.end');
    expect(source).toContain("'.env.test'");
    expect(source).toContain('install --prod');
    expect(source).toContain('devDependencies: pkg.devDependencies');
    expect(source).toContain("'pnpm-workspace.yaml'");
    expect(source).toContain("'--frozen-lockfile'");
    expect(source).toContain('--store-dir');
    expect(source).toContain('--cache-dir');
    expect(source).toContain('--config.node-linker=hoisted');
    expect(source).toContain('isolatedModules === fs.realpathSync(repoModules)');
    expect(source).toContain('buildIsolatedPnpmEnv');
    expect(source).toContain('buildIsolatedWebEnv');
    expect(source).toContain('pnpm.cmd');
    expect(source).toContain('shell: false');
    expect(source).toContain("'/d', '/s', '/c'");
    expect(source).not.toContain('shell: true');
    expect(source).toContain('temp cleanup failed');
    expect(source).not.toMatch(/fs\.cpSync\([^)]*node_modules/u);
    expect(source).not.toMatch(/readFileSync\([^)]*\.env\.test/u);
    expect(source).not.toContain('C:\\\\Users\\\\');
    expect(source).not.toMatch(/\.\.\.process\.env/u);
    expect(source).not.toContain('delete env.NODE_PATH');
  });
});
