import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveArtifactRoot, resolveArtifactRootFromEntry } from '../../../src/config/index.js';

describe('resolveArtifactRoot', () => {
  it('uses an injected absolute directory and ignores process.cwd()', () => {
    const injected = path.join(os.tmpdir(), 'echo-injected-artifact');
    const cwd = process.cwd();
    const resolved = resolveArtifactRoot({ injectedRoot: injected });
    expect(resolved).toBe(path.normalize(injected));
    expect(resolved).not.toBe(cwd);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('rejects a relative injected root instead of resolving it against cwd', () => {
    expect(() => resolveArtifactRoot({ injectedRoot: 'relative-artifact' })).toThrow(
      /absolute path/u,
    );
  });

  it('maps a TypeScript CLI entry under src/ to the sibling dist directory', () => {
    const repo = path.join(os.tmpdir(), 'echo-repo-src');
    const entry = path.join(repo, 'src', 'cli.ts');
    expect(resolveArtifactRootFromEntry(pathToFileURL(entry).href)).toBe(path.join(repo, 'dist'));
  });

  it('uses the directory of a bundled dist/cli.js entry', () => {
    const dist = path.join(os.tmpdir(), 'echo-repo-dist', 'dist');
    const entry = path.join(dist, 'cli.js');
    expect(resolveArtifactRoot({ entryPath: entry })).toBe(path.normalize(dist));
  });

  it('does not follow process.cwd() when resolving an entry path', () => {
    const dist = path.join(os.tmpdir(), 'echo-fixed-dist');
    const entry = path.join(dist, 'cli.js');
    const original = process.cwd();
    const decoy = os.tmpdir();
    try {
      process.chdir(decoy);
      expect(resolveArtifactRoot({ entryPath: entry })).toBe(path.normalize(dist));
      expect(resolveArtifactRoot({ entryPath: entry })).not.toBe(process.cwd());
    } finally {
      process.chdir(original);
    }
  });
});
