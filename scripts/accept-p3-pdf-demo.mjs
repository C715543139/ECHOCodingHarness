import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { p3FixtureRoot, runIndependentTest, verifyProtectedInputs } from './p3-pdf-demo-lib.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repositoryRoot, 'dist', 'cli.js');
const configDirectory = path.join(repositoryRoot, 'dist', 'config');
const configPath = path.join(configDirectory, 'echo.config.json');
const envPath = process.env.ECHO_ENV_FILE ?? path.join(repositoryRoot, '.env.test');

function loadEnvFile() {
  if (!fs.existsSync(envPath)) return;
  for (const sourceLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`P3 real Provider acceptance requires ${name}.`);
  }
  return value;
}

function childEnvironment(apiKey) {
  const env = {};
  for (const name of [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'SYSTEMDRIVE',
    'OS',
  ]) {
    const entry = Object.entries(process.env).find(
      ([candidate]) => candidate.toUpperCase() === name,
    );
    if (entry?.[1] !== undefined) env[entry[0]] = entry[1];
  }
  env.ECHO_API_KEY = apiKey;
  env.NO_COLOR = '1';
  return env;
}

function temporaryConfig(baseUrl, model) {
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      baseUrl,
      model,
      modelCatalog: { source: 'manual', models: [model] },
      safetyMode: 'full-access',
      maxSteps: 24,
      timeoutMs: 60_000,
      maxOutputChars: 24_000,
      requestTimeoutMs: 120_000,
      context: { maxApproxTokens: 256_000, reservedOutputTokens: 16_000 },
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return () => {
    if (previous !== undefined) fs.writeFileSync(configPath, previous);
    else fs.rmSync(configPath, { force: true });
  };
}

function runCli(workspace, apiKey, goal, maxSteps) {
  const args = [
    cliPath,
    'run',
    goal,
    '--workspace',
    workspace,
    '--safety-mode',
    'full-access',
    '--allow-full-access',
    '--max-steps',
    String(maxSteps),
    '--non-interactive',
    '--no-color',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env: childEnvironment(apiKey),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 512_000) output = output.slice(-256_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('P3 real Provider acceptance timed out.'));
    }, 10 * 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

function sessionRequestedTool(workspace, toolName) {
  const sessionsRoot = path.join(workspace, '.echo', 'sessions');
  const files = fs.readdirSync(sessionsRoot).filter((file) => file.endsWith('.jsonl'));
  return files.some((file) =>
    fs
      .readFileSync(path.join(sessionsRoot, file), 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .some((line) => {
        const event = JSON.parse(line);
        return event.type === 'tool.requested' && event.payload?.call?.name === toolName;
      }),
  );
}

loadEnvFile();
const baseUrl = required('ECHO_BASE_URL');
const apiKey = required('ECHO_API_KEY');
const model = required('ECHO_MODEL');
if (!fs.existsSync(cliPath)) throw new Error('Run pnpm build before P3 real Provider acceptance.');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-p3-real-'));
fs.cpSync(p3FixtureRoot, workspace, { recursive: true });
const restoreConfig = temporaryConfig(baseUrl, model);
try {
  await verifyProtectedInputs(workspace);
  const baseline = await runIndependentTest(workspace);
  if (baseline.exitCode === 0) throw new Error('P3 demo failure baseline unexpectedly passed.');

  const first = await runCli(
    workspace,
    apiKey,
    fs.readFileSync(path.join(workspace, 'prompt.txt'), 'utf8'),
    24,
  );
  if (first.exitCode !== 0) {
    process.stderr.write(first.output);
    throw new Error(`P3 real Provider task exited with ${String(first.exitCode)}.`);
  }
  await verifyProtectedInputs(workspace);
  const independent = await runIndependentTest(workspace);
  if (independent.exitCode !== 0) throw new Error('Harness-external verification failed.');

  const second = await runCli(
    workspace,
    apiKey,
    'In this new Session, use the installed read_pdf tool to read requirements.pdf, then state the allowed source file.',
    4,
  );
  if (second.exitCode !== 0 || !sessionRequestedTool(workspace, 'read_pdf')) {
    process.stderr.write(second.output);
    throw new Error('The new Session did not reuse read_pdf successfully.');
  }
  console.log(
    JSON.stringify({
      fixture: 'synthetic-pdf-demo',
      baselineExitCode: baseline.exitCode,
      independentVerificationExitCode: independent.exitCode,
      reusedInNewSession: true,
      protectedHashesUnchanged: true,
      accepted: true,
    }),
  );
} finally {
  restoreConfig();
  fs.rmSync(workspace, { recursive: true, force: true });
}
