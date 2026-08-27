import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CONFIG_FILE_NAMES, type RawConfigValues } from './load-config.js';

export interface ConfigFileResult {
  readonly config: RawConfigValues | undefined;
  readonly error?: string;
}

function extract(raw: unknown): RawConfigValues | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('configuration file root must be a JSON object');
  }
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    // Project files may never supply credentials. Other unknown keys are
    // preserved so loadConfig can report actionable typo warnings.
    if (key !== 'apiKey') {
      values[key] = value;
    }
  }
  return values as RawConfigValues;
}

async function readOne(filePath: string): Promise<RawConfigValues | undefined | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      return null;
    }
    throw error;
  }
  if (text.trim().length === 0) {
    return undefined;
  }
  return extract(JSON.parse(text));
}

export async function loadConfigFile(
  directory: string,
  fileNames: readonly string[] = CONFIG_FILE_NAMES,
): Promise<ConfigFileResult> {
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    try {
      const config = await readOne(filePath);
      if (config === null) {
        continue;
      }
      if (config !== undefined) {
        return { config };
      }
    } catch (error) {
      const message =
        error instanceof SyntaxError
          ? `${fileName} is not valid JSON`
          : `${fileName} could not be read`;
      return { config: undefined, error: message };
    }
  }
  return { config: undefined };
}
