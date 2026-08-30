import { spawnSync } from 'node:child_process';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- no project-owned declaration for scripts/*.mjs
import { MAX_WEB_ARTIFACT_BYTES, scanWebArtifacts } from '../../../scripts/scan-web-artifacts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(ROOT, 'scripts', 'scan-web-artifacts.mjs');
const tempDirs: string[] = [];
const plantedKey = ['sk-', 'testpos_', 'abcdefghijklmnopqrstuvwxyz012345'].join('');
const plantedEmail = ['alice.zhang.eval', '@', 'gmail.com'].join('');

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runScan(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
} {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function joinSample(parts: readonly string[]): string {
  return parts.join('');
}

describe('scan-web-artifacts', () => {
  it('scans error-context.md and flags secrets, identity, reasoning, and absolute paths', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'echo-web-scan-pos-'));
    tempDirs.push(directory);
    const windowsAbs = joinSample(['D:', '\\', 'echo-artifact-scan', '\\', 'notes.txt']);
    const uncAbs = joinSample(['\\\\', 'fileserver', '\\', 'share', '\\', 'notes.txt']);
    const unixHome = joinSample(['/', 'home', '/', 'runner', '/', 'project']);
    const macHome = joinSample(['/', 'Users', '/', 'runner', '/', 'project']);
    await writeFile(
      path.join(directory, 'error-context.md'),
      [
        plantedKey,
        plantedEmail,
        'model.reasoning',
        joinSample(['reasoning', '_', 'details']),
        'reasoningContent',
        windowsAbs,
        uncAbs,
        unixHome,
        macHome,
        os.homedir(),
      ].join('\n'),
      'utf8',
    );

    const result = runScan(['--root', directory]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('error-context.md');
    expect(result.stdout).toContain('rule=openai-key');
    expect(result.stdout).toContain('rule=email');
    expect(result.stdout).toContain('rule=reasoning-leak');
    expect(result.stdout).toContain('rule=absolute-path');
    expect(result.stdout).not.toContain(plantedKey);
    expect(result.stdout).not.toContain(plantedEmail);
    expect(result.stdout).not.toContain(windowsAbs);
    expect(result.stdout).not.toContain(uncAbs);
    expect(result.stdout).not.toContain(unixHome);
    expect(result.stdout).not.toContain(macHome);
    expect(result.stdout).not.toContain(os.homedir());
  });

  it('fail-closes unscannable zip archives instead of skipping them', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'echo-web-scan-zip-'));
    tempDirs.push(directory);
    await writeFile(
      path.join(directory, 'trace.zip'),
      Buffer.from(`PK\u0003\u0004${plantedKey}`, 'latin1'),
    );

    const result = runScan(['--root', directory]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('trace.zip');
    expect(result.stdout).toContain('rule=unscannable-archive');
    expect(result.stdout).not.toContain('web-artifact-scan: passed');
    expect(result.stdout).not.toContain(plantedKey);
  });

  it('fail-closes oversized artifacts instead of skipping them', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'echo-web-scan-huge-'));
    tempDirs.push(directory);
    const handle = await open(path.join(directory, 'huge.png'), 'w');
    await handle.truncate(MAX_WEB_ARTIFACT_BYTES + 1);
    await handle.close();

    const result = runScan(['--root', directory]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('huge.png');
    expect(result.stdout).toContain('rule=oversized-artifact');
    expect(result.stdout).not.toContain('web-artifact-scan: passed');
  });

  it('accepts a clean Playwright artifact directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'echo-web-scan-neg-'));
    tempDirs.push(directory);
    await writeFile(
      path.join(directory, 'page.txt'),
      'ECHO Coding Harness\napiKeyConfigured=true\n',
      'utf8',
    );
    const result = runScan(['--root', directory]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('web-artifact-scan: passed');
  });

  it('covers error-context, zip, oversize, paths, and reasoning_details in --self-test', () => {
    const result = runScan(['--self-test']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('web-artifact-scan self-test: passed');
    expect(result.stdout).not.toContain(plantedKey);
    expect(result.stdout).not.toContain(plantedEmail);
  });

  it('does not skip named Playwright artifacts when scanning programmatically', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'echo-web-scan-api-'));
    tempDirs.push(directory);
    await writeFile(path.join(directory, 'error-context.md'), 'reasoningContent hidden\n', 'utf8');
    await writeFile(path.join(directory, 'trace.zip'), Buffer.from('PK\u0003\u0004', 'latin1'));
    const findings = (await scanWebArtifacts(directory)) as readonly {
      readonly rule: string;
      readonly relativePath: string;
    }[];
    const rules = new Set(findings.map((finding) => finding.rule));
    const names = new Set(findings.map((finding) => finding.relativePath));
    expect(names.has('error-context.md')).toBe(true);
    expect(names.has('trace.zip')).toBe(true);
    expect(rules.has('reasoning-leak')).toBe(true);
    expect(rules.has('unscannable-archive')).toBe(true);
  });
});
