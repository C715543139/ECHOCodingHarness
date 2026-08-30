import { spawn, type ChildProcess } from 'node:child_process';

export const WEB_OPEN_ERROR_CODES = {
  invalidUrl: 'WEB_BOOTSTRAP_URL_INVALID',
  openFailed: 'WEB_BROWSER_OPEN_FAILED',
} as const;

export type WebOpenErrorCode = (typeof WEB_OPEN_ERROR_CODES)[keyof typeof WEB_OPEN_ERROR_CODES];

export interface LoopbackBootstrapExpectation {
  readonly port: number;
  readonly token: string;
}

export interface OpenUrlCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export type SpawnUrlOpener = (
  file: string,
  args: readonly string[],
  options: { readonly shell: false; readonly windowsHide: true },
) => ChildProcess;

export function verifyLoopbackBootstrapUrl(
  candidate: string,
  expected: LoopbackBootstrapExpectation,
): { readonly ok: true; readonly url: string } | { readonly ok: false } {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== 'http:') return { ok: false };
  if (parsed.hostname !== '127.0.0.1') return { ok: false };
  if (parsed.port !== String(expected.port)) return { ok: false };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false };
  if (parsed.pathname !== '/' && parsed.pathname !== '') return { ok: false };
  if (parsed.search !== '') return { ok: false };
  if (parsed.hash !== `#bootstrap=${expected.token}`) return { ok: false };
  return { ok: true, url: parsed.toString() };
}

export function loopbackOpenCommand(
  url: string,
  platform = process.platform,
  comSpec = process.env.ComSpec,
): OpenUrlCommand {
  if (platform === 'win32') {
    return {
      file: comSpec === undefined || comSpec.trim() === '' ? 'cmd.exe' : comSpec,
      args: ['/c', 'start', '', url],
    };
  }
  if (platform === 'darwin') {
    return { file: 'open', args: [url] };
  }
  return { file: 'xdg-open', args: [url] };
}

export function createPlatformUrlOpener(
  spawnImpl: SpawnUrlOpener = spawn as SpawnUrlOpener,
  platform = process.platform,
  comSpec = process.env.ComSpec,
): (url: string) => Promise<void> {
  return async (url: string) => {
    const command = loopbackOpenCommand(url, platform, comSpec);
    await new Promise<void>((resolve, reject) => {
      const child = spawnImpl(command.file, command.args, { shell: false, windowsHide: true });
      child.once('error', () => {
        reject(new Error('The loopback page could not be opened.'));
      });
      child.once('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error('The loopback page could not be opened.'));
      });
    });
  };
}

export function webOpenErrorMessage(code: WebOpenErrorCode): string {
  if (code === WEB_OPEN_ERROR_CODES.invalidUrl) {
    return 'The web console produced an invalid loopback bootstrap URL.';
  }
  return 'The web console could not open the local browser.';
}
