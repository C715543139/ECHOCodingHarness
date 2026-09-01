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

function boundedEnvironmentInteger(name, fallback, maximum) {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${String(maximum)}.`);
  }
  return parsed;
}

const FIRST_RUN_MAX_STEPS = boundedEnvironmentInteger('ECHO_ACCEPT_P3_MAX_STEPS', 128, 160);
const ACCEPTANCE_TIMEOUT_MS = boundedEnvironmentInteger(
  'ECHO_ACCEPT_P3_TIMEOUT_MS',
  15 * 60_000,
  20 * 60_000,
);

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
      maxSteps: FIRST_RUN_MAX_STEPS,
      timeoutMs: 300_000,
      maxOutputChars: 80_000,
      requestTimeoutMs: 600_000,
      context: { maxApproxTokens: 256_000, reservedOutputTokens: 16_000 },
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return () => {
    if (previous !== undefined) fs.writeFileSync(configPath, previous);
    else fs.rmSync(configPath, { force: true });
  };
}

function runCli(workspace, apiKey, goal, maxSteps, timeoutMs) {
  const previousSessions = new Set(sessionFiles(workspace));
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
    child.stdout.resume();
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('P3 real Provider acceptance timed out.'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        createdSessions: sessionFiles(workspace).filter((file) => !previousSessions.has(file)),
      });
    });
  });
}

function sessionFiles(workspace) {
  const sessionsRoot = path.join(workspace, '.echo', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return [];
  return fs.readdirSync(sessionsRoot).filter((file) => file.endsWith('.jsonl'));
}

function sessionEvents(workspace, sessionFile) {
  return fs
    .readFileSync(path.join(workspace, '.echo', 'sessions', sessionFile), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function requestedTools(events) {
  return events
    .filter((event) => event.type === 'tool.requested')
    .map((event) => event.payload?.call)
    .filter((call) => call && typeof call.name === 'string');
}

function requireSingleSession(run, label) {
  if (run.createdSessions.length !== 1) {
    throw new Error(`${label} must create exactly one Session log.`);
  }
  return run.createdSessions[0];
}

function observedToolNames(workspace, run) {
  if (run.createdSessions.length !== 1) return 'no single Session log';
  const names = requestedTools(sessionEvents(workspace, run.createdSessions[0])).map(
    (call) => call.name,
  );
  return names.length === 0 ? 'none' : names.slice(0, 64).join(', ');
}

function observedTerminalResult(workspace, run) {
  if (run.createdSessions.length !== 1) return 'no single Session terminal';
  const terminal = sessionEvents(workspace, run.createdSessions[0])
    .toReversed()
    .find((event) => event.type === 'turn.completed' || event.type === 'turn.failed');
  const result = terminal?.payload?.result;
  if (result === undefined || result === null || typeof result !== 'object') {
    return 'no terminal result';
  }
  return [
    `status=${String(result.status ?? 'unknown')}`,
    `stopReason=${String(result.stopReason ?? 'unknown')}`,
    `steps=${String(result.steps ?? 'unknown')}`,
    `toolCalls=${String(result.toolCalls ?? 'unknown')}`,
  ].join(', ');
}

function inspectAutonomousExtensionFlow(workspace, sessionFile) {
  const calls = requestedTools(sessionEvents(workspace, sessionFile));
  const observedNames = calls.map((call) => call.name).join(', ') || 'none';
  const initIndex = calls.findIndex((call) => call.name === 'extension_init');
  if (initIndex < 0) {
    throw new Error(
      `The Agent did not initialize a durable extension. Observed tools: ${observedNames}.`,
    );
  }
  const init = calls[initIndex];
  const extensionId = init.arguments?.extensionId;
  const toolNames = init.arguments?.toolNames;
  if (
    typeof extensionId !== 'string' ||
    !Array.isArray(toolNames) ||
    toolNames.length === 0 ||
    toolNames.some((name) => typeof name !== 'string')
  ) {
    throw new Error('The extension_init request did not declare a valid reusable tool.');
  }
  const checkIndex = calls.findIndex(
    (call, index) =>
      index > initIndex &&
      call.name === 'extension_check' &&
      call.arguments?.extensionId === extensionId,
  );
  const installIndex = calls.findIndex(
    (call, index) =>
      index > checkIndex &&
      call.name === 'extension_install' &&
      call.arguments?.extensionId === extensionId,
  );
  const pdfIndex = calls.findIndex(
    (call, index) =>
      index > installIndex &&
      toolNames.includes(call.name) &&
      JSON.stringify(call.arguments ?? {}).includes('requirements.pdf'),
  );
  if (checkIndex < 0 || installIndex < 0 || pdfIndex < 0) {
    throw new Error('The Agent did not check, install, and then use its PDF capability in order.');
  }
  const bypass = calls.find(
    (call, index) =>
      index < pdfIndex &&
      call.name !== 'extension_init' &&
      JSON.stringify(call.arguments ?? {}).includes('requirements.pdf'),
  );
  if (bypass !== undefined) {
    throw new Error(`The Agent bypassed the durable PDF capability with ${bypass.name}.`);
  }
  return { extensionId, toolName: calls[pdfIndex].name };
}

loadEnvFile();
const baseUrl = required('ECHO_BASE_URL');
const apiKey = required('ECHO_API_KEY');
const model = required('ECHO_MODEL');
if (!fs.existsSync(cliPath)) throw new Error('Run pnpm build before P3 real Provider acceptance.');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-p3-real-'));
const isolatedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-p3-isolated-'));
fs.cpSync(p3FixtureRoot, workspace, { recursive: true });
fs.cpSync(p3FixtureRoot, isolatedWorkspace, { recursive: true });
const restoreConfig = temporaryConfig(baseUrl, model);
const deadline = Date.now() + ACCEPTANCE_TIMEOUT_MS;
const remainingTime = () => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('P3 real Provider acceptance timed out.');
  return remaining;
};
try {
  await verifyProtectedInputs(workspace);
  const baseline = await runIndependentTest(workspace);
  if (baseline.exitCode === 0) throw new Error('P3 demo failure baseline unexpectedly passed.');

  const first = await runCli(
    workspace,
    apiKey,
    fs.readFileSync(path.join(workspace, 'prompt.txt'), 'utf8'),
    FIRST_RUN_MAX_STEPS,
    remainingTime(),
  );
  if (first.exitCode !== 0) {
    throw new Error(
      `P3 real Provider task exited with ${String(first.exitCode)} (${observedTerminalResult(workspace, first)}). Observed tools: ${observedToolNames(workspace, first)}.`,
    );
  }
  const firstSession = requireSingleSession(first, 'The first run');
  const autonomousFlow = inspectAutonomousExtensionFlow(workspace, firstSession);
  await verifyProtectedInputs(workspace);
  const independent = await runIndependentTest(workspace);
  if (independent.exitCode !== 0) throw new Error('Harness-external verification failed.');

  const second = await runCli(
    workspace,
    apiKey,
    'In this new Session, read requirements.pdf and state the allowed source file. Reuse the durable capability already available in this workspace without repeating setup.',
    4,
    remainingTime(),
  );
  const secondSession = requireSingleSession(second, 'The reuse run');
  const secondCalls = requestedTools(sessionEvents(workspace, secondSession));
  if (
    second.exitCode !== 0 ||
    !secondCalls.some(
      (call) =>
        call.name === autonomousFlow.toolName &&
        JSON.stringify(call.arguments ?? {}).includes('requirements.pdf'),
    )
  ) {
    throw new Error(
      `The new Session did not reuse the installed PDF capability successfully. Observed tools: ${observedToolNames(workspace, second)}.`,
    );
  }
  if (
    fs.existsSync(path.join(isolatedWorkspace, '.echo', 'extensions', autonomousFlow.extensionId))
  ) {
    throw new Error('The workspace extension unexpectedly appeared in another workspace.');
  }
  console.log(
    JSON.stringify({
      fixture: 'synthetic-pdf-demo',
      baselineExitCode: baseline.exitCode,
      independentVerificationExitCode: independent.exitCode,
      reusedInNewSession: true,
      isolatedFromOtherWorkspace: true,
      autonomousExtensionFlow: true,
      protectedHashesUnchanged: true,
      accepted: true,
    }),
  );
} finally {
  restoreConfig();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(isolatedWorkspace, { recursive: true, force: true });
}
