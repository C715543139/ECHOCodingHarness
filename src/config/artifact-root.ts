import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_ERROR_CODES,
  P1_CONFIG_RELATIVE_PATH,
  type ConfigIssue,
} from '../contracts/config.js';

export interface ResolveArtifactRootInput {
  /** Absolute filesystem path or `file:` URL of the CLI entry module. */
  readonly entryPath?: string;
  /** Test and `tsx` injection. Must already be an absolute directory. */
  readonly injectedRoot?: string;
}

export function artifactRootIssue(message: string): ConfigIssue {
  return {
    code: CONFIG_ERROR_CODES.artifactRoot,
    message,
  };
}

/**
 * Resolve the persistent-config root from the CLI entry or an injected directory.
 * Never uses `process.cwd()` or the current workspace.
 */
export function resolveArtifactRoot(input: ResolveArtifactRootInput): string {
  if (input.injectedRoot !== undefined) {
    if (!path.isAbsolute(input.injectedRoot)) {
      throw new Error('Injected artifact-root must be an absolute path.');
    }
    return path.normalize(input.injectedRoot);
  }

  if (input.entryPath === undefined || input.entryPath.trim().length === 0) {
    throw new Error('CLI entry path is required to resolve artifact-root.');
  }

  const entryFile = entryPathToFile(input.entryPath);
  if (!path.isAbsolute(entryFile)) {
    throw new Error('CLI entry path must be absolute.');
  }

  const entryDir = path.dirname(entryFile);
  const fileName = path.basename(entryFile);
  if (fileName === 'cli.ts' && path.basename(entryDir) === 'src') {
    return path.normalize(path.join(entryDir, '..', 'dist'));
  }
  return path.normalize(entryDir);
}

export function resolveArtifactRootFromEntry(entryUrl: string): string {
  return resolveArtifactRoot({ entryPath: entryUrl });
}

function entryPathToFile(entryPath: string): string {
  if (entryPath.startsWith('file:')) {
    return fileURLToPath(entryPath);
  }
  return entryPath;
}

export function isAbsoluteArtifactRoot(candidate: string): boolean {
  return path.isAbsolute(candidate);
}

export function persistentConfigPath(artifactRoot: string): string {
  return path.join(artifactRoot, ...P1_CONFIG_RELATIVE_PATH.split('/'));
}
