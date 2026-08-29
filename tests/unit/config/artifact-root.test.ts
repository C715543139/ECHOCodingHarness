import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { persistentConfigPath } from '../../../src/config/index.js';

describe('persistentConfigPath', () => {
  it('places config beside sessions under workspace .echo', () => {
    const workspace = path.join(os.tmpdir(), 'echo-workspace');
    const resolved = persistentConfigPath(workspace);
    expect(resolved).toBe(path.join(workspace, '.echo', 'config', 'echo.config.json'));
    expect(resolved.replaceAll('\\', '/')).toContain('.echo/config/echo.config.json');
  });

  it('does not resolve against process.cwd() when the workspace is absolute', () => {
    const workspace = path.join(os.tmpdir(), 'echo-fixed-workspace');
    const original = process.cwd();
    try {
      process.chdir(os.tmpdir());
      expect(persistentConfigPath(workspace)).toBe(
        path.join(workspace, '.echo', 'config', 'echo.config.json'),
      );
      expect(persistentConfigPath(workspace)).not.toBe(
        path.join(process.cwd(), '.echo', 'config', 'echo.config.json'),
      );
    } finally {
      process.chdir(original);
    }
  });
});
