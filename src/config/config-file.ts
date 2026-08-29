import * as fs from 'node:fs/promises';

import { CONFIG_ERROR_CODES, type ConfigIssue } from '../contracts/config.js';

import { persistentConfigPath } from './artifact-root.js';

export type PersistentConfigFileResult =
  | { readonly status: 'missing' }
  | { readonly status: 'loaded'; readonly raw: unknown }
  | { readonly status: 'error'; readonly issue: ConfigIssue };

export async function readPersistentConfigFile(
  artifactRoot: string,
): Promise<PersistentConfigFileResult> {
  const filePath = persistentConfigPath(artifactRoot);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { status: 'missing' };
    }
    return {
      status: 'error',
      issue: {
        code: CONFIG_ERROR_CODES.invalid,
        message: `${filePath} could not be read.`,
        path: filePath,
      },
    };
  }

  if (text.trim().length === 0) {
    return {
      status: 'error',
      issue: {
        code: CONFIG_ERROR_CODES.invalid,
        message: 'Configuration file is empty.',
        path: filePath,
      },
    };
  }

  try {
    return { status: 'loaded', raw: JSON.parse(text) as unknown };
  } catch {
    return {
      status: 'error',
      issue: {
        code: CONFIG_ERROR_CODES.invalid,
        message: 'Configuration file is not valid JSON.',
        path: filePath,
      },
    };
  }
}
