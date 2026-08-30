import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const configDirectory = path.join(repoRoot, 'dist', 'config');
const configPath = path.join(configDirectory, 'echo.config.json');
const envFile = process.env.ECHO_ENV_FILE ?? path.join(repoRoot, '.env.test');
const urlPattern = /http:\/\/127\.0\.0\.1:(\d+)\/#bootstrap=([0-9a-f]{64})/u;
const timeoutMs = 120_000;

async function loadEnvFile() {
  if (!fs.existsSync(envFile)) return;
  const source = fs.readFileSync(envFile, 'utf8');
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
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
    throw new Error(`Real Web Provider acceptance requires ${name}.`);
  }
  return value;
}

function childEnvironment(apiKey) {
  const allowed = [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'SYSTEMDRIVE',
    'OS',
  ];
  const env = {};
  for (const name of allowed) {
    const entry = Object.entries(process.env).find(
      ([candidate]) => candidate.toUpperCase() === name,
    );
    if (entry?.[1] !== undefined) env[entry[0]] = entry[1];
  }
  env.ECHO_API_KEY = apiKey;
  return env;
}

function writeTemporaryConfig(baseUrl, model) {
  const existed = fs.existsSync(configPath);
  const previous = existed ? fs.readFileSync(configPath) : undefined;
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      baseUrl,
      model,
      modelCatalog: { source: 'manual', models: [model] },
      safetyMode: 'balanced',
      maxSteps: 2,
      timeoutMs: 30_000,
      maxOutputChars: 8_000,
      requestTimeoutMs: 60_000,
      context: { maxApproxTokens: 8_000, reservedOutputTokens: 2_000 },
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return () => {
    if (previous !== undefined) {
      fs.writeFileSync(configPath, previous);
      return;
    }
    fs.rmSync(configPath, { force: true });
    try {
      fs.rmdirSync(configDirectory);
    } catch {
      // Keep a non-empty directory that was created by another local process.
    }
  };
}

function startWeb(workspace, apiKey) {
  const child = spawn(process.execPath, [cliPath, 'web', '--workspace', workspace, '--no-open'], {
    cwd: workspace,
    env: childEnvironment(apiKey),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Real Web Provider acceptance server startup timed out.'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = urlPattern.exec(stdout);
      if (match === null || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ child, port: Number(match[1]), token: match[2] });
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Real Web Provider acceptance server exited before startup.'));
    });
  });
}

function requestHeaders(origin, cookie, mutating = false) {
  return {
    Host: new URL(origin).host,
    ...(cookie === undefined ? {} : { Cookie: `echo_web=${cookie}` }),
    ...(mutating
      ? {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-Echo-Request-Id': `accept_${crypto.randomUUID()}`,
        }
      : {}),
  };
}

async function responseJson(response, expected) {
  if (response.status !== expected) {
    throw new Error(`Real Web Provider acceptance received HTTP ${String(response.status)}.`);
  }
  return response.json();
}

async function awaitTerminalStream(response) {
  if (!response.ok || response.body === null) {
    throw new Error('Real Web Provider acceptance could not open the Session stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timer;
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Real Web Provider acceptance stream timed out.')),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (buffer.includes('event: turn.terminal')) return;
      if (buffer.length > 256_000) buffer = buffer.slice(-128_000);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error('Real Web Provider acceptance observed no terminal Turn event.');
}

function assertPrivate(value, secret, workspace) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    secret,
    workspace,
    workspace.replaceAll('\\', '/'),
    os.homedir(),
    'model.reasoning',
    'reasoning_details',
    'reasoningContent',
  ].filter((item) => item.length > 0);
  if (forbidden.some((item) => serialized.includes(item))) {
    throw new Error('Real Web Provider acceptance detected private data in a Web payload.');
  }
}

async function stopWeb(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.stdin.end();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

await loadEnvFile();
const baseUrl = required('ECHO_BASE_URL');
const apiKey = required('ECHO_API_KEY');
const model = required('ECHO_MODEL');
if (!fs.existsSync(cliPath)) throw new Error('Run pnpm build before real Web Provider acceptance.');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-web-provider-'));
const restoreConfig = writeTemporaryConfig(baseUrl, model);
let child;
const startedAt = Date.now();
try {
  const started = await startWeb(workspace, apiKey);
  child = started.child;
  const origin = `http://127.0.0.1:${String(started.port)}`;

  const authentication = await fetch(`${origin}/api/v1/auth/bootstrap`, {
    method: 'POST',
    headers: requestHeaders(origin, undefined, true),
    body: JSON.stringify({ token: started.token }),
  });
  if (authentication.status !== 204) {
    throw new Error('Real Web Provider acceptance bootstrap failed.');
  }
  const cookieSource =
    authentication.headers.getSetCookie?.()[0] ?? authentication.headers.get('set-cookie') ?? '';
  const cookie = /echo_web=([^;]+)/u.exec(cookieSource)?.[1];
  if (cookie === undefined) throw new Error('Real Web Provider acceptance cookie was missing.');

  const created = await responseJson(
    await fetch(`${origin}/api/v1/sessions`, {
      method: 'POST',
      headers: requestHeaders(origin, cookie, true),
      body: '{}',
    }),
    201,
  );
  assertPrivate(created, apiKey, workspace);
  const sessionId = created.data?.session?.id;
  if (typeof sessionId !== 'string') {
    throw new Error('Real Web Provider acceptance SessionView was invalid.');
  }

  const streamController = new AbortController();
  const streamResponse = await fetch(
    `${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}/events?after=0`,
    {
      headers: requestHeaders(origin, cookie),
      signal: streamController.signal,
    },
  );
  const terminal = awaitTerminalStream(streamResponse);
  const submitted = await fetch(
    `${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      method: 'POST',
      headers: requestHeaders(origin, cookie, true),
      body: JSON.stringify({
        text: 'Reply with exactly ECHO_WEB_PROVIDER_OK. Do not call tools.',
      }),
    },
  );
  await responseJson(submitted, 202);
  await terminal;
  streamController.abort();

  const [restored, chat, trace] = await Promise.all([
    fetch(`${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      headers: requestHeaders(origin, cookie),
    }).then((response) => responseJson(response, 200)),
    fetch(`${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}/chat?limit=30`, {
      headers: requestHeaders(origin, cookie),
    }).then((response) => responseJson(response, 200)),
    fetch(`${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}/trace?after=0&limit=200`, {
      headers: requestHeaders(origin, cookie),
    }).then((response) => responseJson(response, 200)),
  ]);
  for (const payload of [restored, chat, trace]) assertPrivate(payload, apiKey, workspace);

  const turn = chat.data?.items?.at(-1);
  if (turn?.status !== 'completed' || !turn.responses?.some((item) => item.text?.length > 0)) {
    throw new Error('Real Web Provider acceptance did not restore completed aggregated Chat.');
  }
  const types = new Set(trace.data?.items?.map((item) => item.type));
  if (!types.has('user') || !types.has('agent') || !types.has('turn')) {
    throw new Error('Real Web Provider acceptance Trace was incomplete.');
  }
  if (restored.data?.session?.id !== sessionId) {
    throw new Error('Real Web Provider acceptance did not restore the Session.');
  }

  const exitCode = await stopWeb(child);
  child = undefined;
  if (exitCode !== 0) throw new Error('Real Web Provider acceptance shutdown failed.');
  process.stdout.write(
    `Real Web Provider acceptance passed · model=${model} · durationMs=${String(Date.now() - startedAt)}\n`,
  );
} finally {
  if (child !== undefined) await stopWeb(child);
  restoreConfig();
  fs.rmSync(workspace, { recursive: true, force: true });
}
