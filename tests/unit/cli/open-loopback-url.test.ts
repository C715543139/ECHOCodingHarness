import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createPlatformUrlOpener,
  loopbackOpenCommand,
  verifyLoopbackBootstrapUrl,
  webOpenErrorMessage,
} from '../../../src/cli/open-loopback-url.js';

const TOKEN = 'a'.repeat(64);
const URL = `http://127.0.0.1:4317/#bootstrap=${TOKEN}`;

describe('verifyLoopbackBootstrapUrl', () => {
  it('accepts the server-issued loopback bootstrap URL', () => {
    expect(verifyLoopbackBootstrapUrl(URL, { port: 4317, token: TOKEN })).toEqual({
      ok: true,
      url: URL,
    });
  });

  it.each([
    ['https://127.0.0.1:4317/#bootstrap=' + TOKEN],
    ['http://localhost:4317/#bootstrap=' + TOKEN],
    ['http://127.0.0.1:9/#bootstrap=' + TOKEN],
    ['http://8.8.8.8:4317/#bootstrap=' + TOKEN],
    ['http://127.0.0.1:4317/extra#bootstrap=' + TOKEN],
    ['http://127.0.0.1:4317/?q=1#bootstrap=' + TOKEN],
    ['http://127.0.0.1:4317/#bootstrap=other'],
    ['not-a-url'],
  ])('rejects %s without echoing the token', (candidate) => {
    const result = verifyLoopbackBootstrapUrl(candidate, { port: 4317, token: TOKEN });
    expect(result).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(webOpenErrorMessage('WEB_BOOTSTRAP_URL_INVALID')).not.toContain(TOKEN);
    expect(webOpenErrorMessage('WEB_BOOTSTRAP_URL_INVALID')).not.toMatch(
      /[/\\]Users[/\\]|ECHO_API_KEY/u,
    );
  });
});

describe('loopbackOpenCommand', () => {
  it('uses a Windows argument array and does not build a shell string', () => {
    const command = loopbackOpenCommand(URL, 'win32', 'C:\\Windows\\System32\\cmd.exe');
    expect(command.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(command.args).toEqual(['/c', 'start', '', URL]);
    expect(command.args.join('\0')).toContain(URL);
  });

  it('uses open and xdg-open argument arrays on unix-like platforms', () => {
    expect(loopbackOpenCommand(URL, 'darwin').args).toEqual([URL]);
    expect(loopbackOpenCommand(URL, 'linux').file).toBe('xdg-open');
    expect(loopbackOpenCommand(URL, 'linux').args).toEqual([URL]);
  });
});

describe('createPlatformUrlOpener', () => {
  it('spawns with shell disabled and the exact URL argument', async () => {
    const spawnImpl = vi.fn().mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    });
    const openUrl = createPlatformUrlOpener(spawnImpl, 'win32', 'cmd.exe');
    await openUrl(URL);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith('cmd.exe', ['/c', 'start', '', URL], {
      shell: false,
      windowsHide: true,
    });
  });
});
