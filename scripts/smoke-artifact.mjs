import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

if (!fs.existsSync(repoCli)) {
  throw new Error('Artifact smoke requires dist/cli.js. Run pnpm build first.');
}

const artifactConfigDir = path.join(path.dirname(repoCli), 'config');
const artifactConfig = path.join(artifactConfigDir, 'echo.config.json');
const hadConfig = fs.existsSync(artifactConfig);
const configBackup = hadConfig ? fs.readFileSync(artifactConfig) : undefined;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-artifact-smoke-'));
const cwd = path.join(tempRoot, 'cwd');
const decoyModel = 'cwd-decoy-model';
const smokeKey = 'artifact-smoke-key';

function runCli(options = {}) {
  const env = { ...process.env };
  delete env.ECHO_RUN_PROVIDER_SMOKE;
  if (Object.hasOwn(options, 'apiKey')) {
    if (options.apiKey === undefined) {
      delete env.ECHO_API_KEY;
    } else {
      env.ECHO_API_KEY = options.apiKey;
    }
  }
  env.NO_COLOR = '1';
  return spawnSync(process.execPath, [repoCli, ...(options.args ?? ['--help'])], {
    cwd,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

function combined(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

try {
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'echo.config.json'),
    `${JSON.stringify({
      baseUrl: 'https://cwd.example/v1',
      model: decoyModel,
      modelCatalog: { source: 'discover' },
      safetyMode: 'auto',
    })}\n`,
    'utf8',
  );
  fs.mkdirSync(path.join(cwd, '.echo', 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.echo', 'config', 'echo.config.json'),
    `${JSON.stringify({
      baseUrl: 'https://echo.example/v1',
      model: 'workspace-echo-decoy',
      modelCatalog: { source: 'discover' },
      safetyMode: 'auto',
    })}\n`,
    'utf8',
  );
  if (hadConfig) {
    fs.rmSync(artifactConfig);
  }

  const help = runCli();
  if (help.status !== 0) {
    throw new Error(`Artifact CLI --help failed:\n${combined(help)}`);
  }
  if (
    !help.stdout.includes('run') ||
    !help.stdout.includes('chat') ||
    !help.stdout.includes('config')
  ) {
    throw new Error('Artifact CLI help did not list run, chat, and config.');
  }

  const missing = runCli({
    args: ['run', 'ignore cwd decoy', '--non-interactive', '--no-color'],
    apiKey: smokeKey,
  });
  const missingText = combined(missing);
  if (missing.status !== 2) {
    throw new Error(
      `Missing artifact config expected exit 2, got ${String(missing.status)}:\n${missingText}`,
    );
  }
  if (!missingText.includes('echo-harness config')) {
    throw new Error('Missing artifact config did not suggest echo-harness config.');
  }
  if (missingText.includes(decoyModel)) {
    throw new Error('Artifact CLI used a cwd decoy config file.');
  }
  if (missingText.includes('workspace-echo-decoy')) {
    throw new Error('Artifact CLI used a workspace .echo/config decoy.');
  }
  if (missingText.includes(smokeKey)) {
    throw new Error('Artifact CLI leaked the API key.');
  }

  fs.mkdirSync(artifactConfigDir, { recursive: true });
  fs.writeFileSync(
    artifactConfig,
    `${JSON.stringify({
      baseUrl: 'https://artifact.example/v1',
      model: 'artifact-root-model',
      modelCatalog: { source: 'manual', models: ['artifact-root-model'] },
      safetyMode: 'balanced',
    })}\n`,
    'utf8',
  );

  const noKey = runCli({
    args: ['run', 'ignore cwd decoy', '--non-interactive', '--no-color'],
    apiKey: undefined,
  });
  const noKeyText = combined(noKey);
  if (noKey.status !== 2) {
    throw new Error(`Missing API key expected exit 2, got ${String(noKey.status)}:\n${noKeyText}`);
  }
  if (!noKeyText.includes('ECHO_API_KEY')) {
    throw new Error('Missing API key did not mention ECHO_API_KEY.');
  }
  if (noKeyText.includes(decoyModel)) {
    throw new Error('Artifact CLI with a real config still followed the cwd decoy model.');
  }
  if (noKeyText.includes('workspace-echo-decoy')) {
    throw new Error('Artifact CLI with a real config still followed workspace .echo/config.');
  }

  process.stdout.write('Artifact smoke check passed.\n');
} finally {
  if (configBackup !== undefined) {
    fs.mkdirSync(artifactConfigDir, { recursive: true });
    fs.writeFileSync(artifactConfig, configBackup);
  } else if (fs.existsSync(artifactConfigDir)) {
    fs.rmSync(artifactConfigDir, { recursive: true, force: true });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
