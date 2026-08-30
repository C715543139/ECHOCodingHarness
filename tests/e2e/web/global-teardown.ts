import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default function globalTeardown(): void {
  const outputDir = process.env.ECHO_PW_OUTPUT_DIR;
  if (outputDir === undefined || outputDir.length === 0) {
    return;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  execFileSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'scan-web-artifacts.mjs'), '--root', outputDir],
    {
      stdio: 'inherit',
      windowsHide: true,
    },
  );
}
