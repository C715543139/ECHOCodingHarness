import { CONFIG_ERROR_CODES } from '../contracts/config.js';
import type { ConfigIssue } from '../contracts/config.js';

import { isAbsoluteArtifactRoot } from './artifact-root.js';
import { checkConfig } from './check-config.js';
import { readPersistentConfigFile } from './config-file.js';
import {
  loadConfig,
  missingConfigIssues,
  type ConfigLoadResult,
  type RawConfigValues,
} from './load-config.js';

export interface RuntimeConfigInput {
  readonly artifactRoot: string;
  readonly env?: Record<string, string | undefined>;
  readonly overrides?: RawConfigValues;
}

function artifactRootIssues(artifactRoot: string): ConfigIssue[] | undefined {
  if (!isAbsoluteArtifactRoot(artifactRoot)) {
    return [
      {
        code: CONFIG_ERROR_CODES.artifactRoot,
        message:
          'artifact-root must be an absolute path derived from the CLI entry, not process.cwd().',
      },
    ];
  }
  return undefined;
}

export async function loadRuntimeConfig(input: RuntimeConfigInput): Promise<ConfigLoadResult> {
  const rootIssues = artifactRootIssues(input.artifactRoot);
  if (rootIssues !== undefined) {
    return { ok: false, issues: rootIssues };
  }

  const file = await readPersistentConfigFile(input.artifactRoot);
  if (file.status === 'missing') {
    return { ok: false, issues: missingConfigIssues() };
  }
  if (file.status === 'error') {
    return { ok: false, issues: [file.issue] };
  }

  const loaded = loadConfig({
    fileConfig: file.raw,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
  });
  if (!loaded.ok) {
    return loaded;
  }

  const checked = checkConfig(loaded.config);
  if (!checked.ok) {
    return {
      ok: false,
      issues: checked.issues.map((item) => ({
        code: item.code,
        message: item.message,
      })),
    };
  }
  return loaded;
}
