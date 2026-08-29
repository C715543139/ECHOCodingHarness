import * as path from 'node:path';

import { P1_CONFIG_RELATIVE_PATH } from '../contracts/config.js';

/**
 * Persistent config lives under the resolved workspace, beside sessions:
 * `<workspace>/.echo/config/echo.config.json`.
 */
export function persistentConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ...P1_CONFIG_RELATIVE_PATH.split('/'));
}

export function isAbsoluteWorkspaceRoot(candidate: string): boolean {
  return path.isAbsolute(candidate);
}
