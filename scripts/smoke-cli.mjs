import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const result = spawnSync(process.execPath, [cliPath, '--help'], {
  encoding: 'utf8',
  windowsHide: true,
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  throw new Error(
    `CLI smoke check failed with exit code ${String(result.status)}:\n${result.stderr}`,
  );
}

if (!result.stdout.includes('echo-harness') || !result.stdout.includes('ECHO Harness')) {
  throw new Error('CLI smoke check did not produce the expected help output.');
}
if (!result.stdout.includes('run') || !result.stdout.includes('config')) {
  throw new Error('CLI smoke check did not list the run and config commands.');
}

process.stdout.write('CLI smoke check passed.\n');
