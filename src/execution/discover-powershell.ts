import { access, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

const POWERSHELL_SEGMENTS = ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'] as const;

let cachedExecutable: string | undefined;

function resolveSystemRoot(env: Readonly<NodeJS.ProcessEnv>): string | undefined {
  const candidates = [env.SYSTEMROOT, env.SystemRoot, env.WINDIR, env.windir];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

export function buildControlledPowerShellExecutablePath(systemRoot: string): string {
  return join(systemRoot, ...POWERSHELL_SEGMENTS);
}

export async function discoverPowerShellExecutable(
  env?: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  if (cachedExecutable !== undefined) {
    return cachedExecutable;
  }

  const sourceEnv = env ?? process.env;
  const systemRoot = resolveSystemRoot(sourceEnv);
  if (systemRoot === undefined) {
    throw new Error('Cannot discover PowerShell because SYSTEMROOT is unavailable.');
  }

  const candidate = buildControlledPowerShellExecutablePath(systemRoot);
  await access(candidate);
  const resolved = await realpath(candidate);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) {
    throw new Error('The discovered PowerShell path is not a file.');
  }

  cachedExecutable = resolved;
  return resolved;
}

/** Test-only hook to reset memoized discovery between unit cases. */
export function resetDiscoveredPowerShellExecutableForTests(): void {
  cachedExecutable = undefined;
}
