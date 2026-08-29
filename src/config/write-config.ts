import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { EchoPersistentConfig } from '../contracts/config.js';
import { CONFIG_ERROR_CODES } from '../contracts/config.js';

import { persistentConfigPath } from './artifact-root.js';
import { serializePersistentConfig } from './schema.js';

export interface ConfigFileWriter {
  mkdir(directory: string): Promise<void>;
  writeFile(filePath: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(filePath: string): Promise<void>;
}

export interface WritePersistentConfigResult {
  readonly path: string;
}

const defaultWriter: ConfigFileWriter = {
  mkdir: async (directory) => {
    await fs.mkdir(directory, { recursive: true });
  },
  writeFile: async (filePath, contents) => {
    await fs.writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' });
  },
  rename: async (from, to) => {
    await fs.rename(from, to);
  },
  rm: async (filePath) => {
    await fs.rm(filePath, { force: true });
  },
};

function assertNoSecrets(payload: string): void {
  const lowered = payload.toLowerCase();
  if (lowered.includes('"apikey"') || lowered.includes('"authorization"')) {
    throw new Error('Refusing to persist credentials in the configuration file.');
  }
}

async function replaceAtomically(
  writer: ConfigFileWriter,
  tempPath: string,
  destPath: string,
): Promise<void> {
  try {
    await writer.rename(tempPath, destPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }
  }

  const backupPath = `${destPath}.${randomUUID()}.bak`;
  let movedAside = false;
  try {
    await writer.rename(destPath, backupPath);
    movedAside = true;
    await writer.rename(tempPath, destPath);
    await writer.rm(backupPath);
  } catch (error) {
    if (movedAside) {
      try {
        await writer.rename(backupPath, destPath);
      } catch {
        // Restoration is best-effort; the original error is more useful.
      }
    }
    throw error;
  }
}

export async function writePersistentConfigFile(
  workspaceRoot: string,
  config: EchoPersistentConfig,
  writer: ConfigFileWriter = defaultWriter,
): Promise<WritePersistentConfigResult> {
  const destPath = persistentConfigPath(workspaceRoot);
  const directory = path.dirname(destPath);
  const serialized = serializePersistentConfig(config);
  const payload = `${JSON.stringify(serialized, null, 2)}\n`;
  assertNoSecrets(payload);

  const tempPath = path.join(directory, `.echo.config.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writer.mkdir(directory);
    await writer.writeFile(tempPath, payload);
    await replaceAtomically(writer, tempPath, destPath);
  } catch (error) {
    await writer.rm(tempPath);
    const message = error instanceof Error ? error.message : 'Configuration write failed.';
    throw Object.assign(new Error(message), {
      code: CONFIG_ERROR_CODES.invalid,
      cause: error,
    });
  }
  return { path: destPath };
}
