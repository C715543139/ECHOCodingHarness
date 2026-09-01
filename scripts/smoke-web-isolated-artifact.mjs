import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const repoCli = path.join(repoRoot, 'dist', 'cli.js');
const repoWebIndex = path.join(repoRoot, 'dist', 'web', 'index.html');

export const ISOLATED_WEB_SMOKE_KEY = 'isolated-web-smoke-key';
const BOOTSTRAP_URL = /http:\/\/127\.0\.0\.1:(\d+)\/#bootstrap=([0-9a-f]{16,128})/u;

const WINDOWS_CHILD_ENV_ALLOWLIST = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'SYSTEMDRIVE',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'NUMBER_OF_PROCESSORS',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'PROGRAMDATA',
  ].map((name) => name.toUpperCase()),
);

function isDeniedSecretEnvName(name) {
  const upper = name.toUpperCase();
  if (upper.startsWith('ECHO_')) {
    return true;
  }
  if (upper === 'CI' || upper === 'CONTINUOUS_INTEGRATION') {
    return true;
  }
  if (
    upper.startsWith('GITHUB_') ||
    upper.startsWith('GITLAB_') ||
    upper.startsWith('CIRCLE_') ||
    upper.startsWith('TRAVIS_') ||
    upper.startsWith('TF_') ||
    upper.startsWith('AWS_') ||
    upper.startsWith('AZURE_') ||
    upper.startsWith('GCP_') ||
    upper.startsWith('GOOGLE_') ||
    upper.startsWith('NPM_') ||
    upper.startsWith('NUGET_')
  ) {
    return true;
  }
  return (
    upper.includes('TOKEN') ||
    upper.includes('SECRET') ||
    upper.includes('PASSWORD') ||
    upper.includes('CREDENTIAL') ||
    upper.includes('API_KEY') ||
    upper.endsWith('_KEY')
  );
}

export function readEnvIgnoreCase(env, name) {
  const target = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.toUpperCase() === target && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function buildMinimalChildEnv(source) {
  const sanitized = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const upper = name.toUpperCase();
    if (!WINDOWS_CHILD_ENV_ALLOWLIST.has(upper)) {
      continue;
    }
    if (isDeniedSecretEnvName(name)) {
      continue;
    }
    sanitized[name] = value;
  }
  return sanitized;
}

export function buildIsolatedPnpmEnv(source) {
  const env = buildMinimalChildEnv(source);
  env.npm_config_link_workspace_packages = 'false';
  return env;
}

export function buildIsolatedWebEnv(source, apiKey) {
  const env = buildMinimalChildEnv(source);
  env.ECHO_API_KEY = apiKey;
  env.NO_COLOR = '1';
  return env;
}

export function resolvePnpmExecutable(source = process.env) {
  if (process.platform !== 'win32') {
    return 'pnpm';
  }
  const pathValue = readEnvIgnoreCase(source, 'PATH') ?? '';
  for (const dir of pathValue.split(';')) {
    if (dir.trim().length === 0) {
      continue;
    }
    const candidate = path.join(dir.trim(), 'pnpm.cmd');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'pnpm.cmd';
}

export function isolatedPublishConfig() {
  return {
    baseUrl: 'https://provider.example/v1',
    model: 'fake-model',
    modelCatalog: { source: 'discover' },
    safetyMode: 'balanced',
  };
}

export function quoteWindowsCmdArg(value) {
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s"&<>|^()%!]/u.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildPnpmSpawnInvocation(args, env) {
  if (process.platform !== 'win32') {
    return {
      command: 'pnpm',
      args: [...args],
      shell: false,
    };
  }
  const comspec = readEnvIgnoreCase(env, 'ComSpec') ?? 'cmd.exe';
  const commandLine = [resolvePnpmExecutable(env), ...args].map(quoteWindowsCmdArg).join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', commandLine],
    shell: false,
  };
}

function redact(text, secret) {
  return text.replaceAll(secret, '<redacted>');
}

function sanitizeSmokeText(text) {
  let output = redact(text, ISOLATED_WEB_SMOKE_KEY);
  const home = os.homedir();
  if (home.length > 0) {
    output = output.replaceAll(home, '<redacted>');
  }
  return output;
}

export function resolvePnpmCacheDir(source = process.env) {
  const candidates = [];
  const localAppData = readEnvIgnoreCase(source, 'LOCALAPPDATA');
  if (localAppData !== undefined) {
    candidates.push(path.join(localAppData, 'pnpm-cache'));
  }
  const home = os.homedir();
  if (home.length > 0) {
    candidates.push(path.join(home, '.pnpm-cache'));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function combined(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function spawnPnpmSync(args, options) {
  const invocation = buildPnpmSpawnInvocation(args, options.env ?? {});
  return spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
    shell: invocation.shell,
  });
}

function assertTextHasNoSecrets(text, forbidden, label) {
  for (const value of forbidden) {
    if (typeof value === 'string' && value.length > 0 && text.includes(value)) {
      throw new Error(`${label} leaked a secret.`);
    }
  }
}

function copyPublishTree(packageDir) {
  fs.mkdirSync(path.join(packageDir, 'dist', 'web'), { recursive: true });
  for (const name of fs.readdirSync(path.join(repoRoot, 'dist'))) {
    const source = path.join(repoRoot, 'dist', name);
    if (!fs.statSync(source).isFile() || !name.endsWith('.js')) {
      continue;
    }
    fs.copyFileSync(source, path.join(packageDir, 'dist', name));
  }
  fs.cpSync(path.join(repoRoot, 'dist', 'web'), path.join(packageDir, 'dist', 'web'), {
    recursive: true,
  });
  fs.copyFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), path.join(packageDir, 'pnpm-lock.yaml'));
  fs.copyFileSync(
    path.join(repoRoot, 'pnpm-workspace.yaml'),
    path.join(packageDir, 'pnpm-workspace.yaml'),
  );
  fs.mkdirSync(path.join(packageDir, 'dist', 'config'), { recursive: true });
  const publishConfig = isolatedPublishConfig();
  const configText = `${JSON.stringify(publishConfig)}\n`;
  assertTextHasNoSecrets(configText, [ISOLATED_WEB_SMOKE_KEY], 'Isolated artifact config');
  fs.writeFileSync(path.join(packageDir, 'dist', 'config', 'echo.config.json'), configText, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        private: true,
        type: pkg.type,
        bin: { 'echo-harness': './dist/cli.js' },
        engines: pkg.engines,
        dependencies: pkg.dependencies,
        // Keep the copied manifest aligned with the full lockfile. --prod below still prevents
        // development dependencies from being installed in the isolated artifact.
        devDependencies: pkg.devDependencies,
      },
      null,
      2,
    )}\n`,
  );
}

function resolvePnpmStoreDir(env) {
  const result = spawnPnpmSync(['store', 'path'], {
    cwd: repoRoot,
    env,
  });
  const storeDir = (result.stdout ?? '').trim().split(/\r?\n/u).at(-1)?.trim() ?? '';
  if (result.status !== 0 || storeDir.length === 0) {
    throw new Error(
      `Could not resolve the pnpm store path for isolated install:\n${sanitizeSmokeText(result.stderr ?? '')}`,
    );
  }
  return storeDir;
}

function installIsolatedProdDeps(packageDir, env, sourceEnv) {
  const cacheDir = resolvePnpmCacheDir(sourceEnv);
  if (cacheDir === undefined) {
    throw new Error('Isolated pnpm install requires a local offline cache for --prod --offline.');
  }
  const installArgs = [
    'install',
    '--prod',
    '--offline',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--config.node-linker=hoisted',
    '--store-dir',
    resolvePnpmStoreDir(env),
    '--cache-dir',
    cacheDir,
  ];
  const result = spawnPnpmSync(installArgs, {
    cwd: packageDir,
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `Isolated pnpm install --prod failed:\n${sanitizeSmokeText(combined({ stdout: result.stdout, stderr: result.stderr }))}`,
    );
  }
}

function waitForBootstrap(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (action) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      action();
    };
    const timer = setTimeout(() => {
      settle(() => {
        reject(
          new Error(
            `Isolated Web console did not print a loopback bootstrap URL within ${String(timeoutMs)}ms.`,
          ),
        );
      });
    }, timeoutMs);
    const tryMatch = () => {
      const match = BOOTSTRAP_URL.exec(stdout);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        settle(() => {
          resolve({ port: match[1], token: match[2], stdout, stderr });
        });
      }
    };
    const onStdout = (chunk) => {
      stdout += chunk;
      tryMatch();
    };
    const onStderr = (chunk) => {
      stderr += chunk;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.once('exit', (code) => {
      if (BOOTSTRAP_URL.exec(stdout) === null) {
        settle(() => {
          reject(
            new Error(
              `Isolated Web console exited ${String(code)} before printing a bootstrap URL:\n${sanitizeSmokeText(combined({ stdout, stderr }))}`,
            ),
          );
        });
      }
    });
  });
}

function stopChild(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Isolated Web console did not exit within the 10s shutdown window.'));
    }, 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    if (child.stdin === null) {
      child.kill('SIGTERM');
      return;
    }
    child.stdin.end();
  });
}

function assertIsolatedTree(packageDir) {
  const forbidden = ['src', '.env.test', '.git', 'tests', 'scripts'];
  for (const name of forbidden) {
    if (fs.existsSync(path.join(packageDir, name))) {
      throw new Error(`Isolated package unexpectedly contains ${name}.`);
    }
  }
  if (!fs.existsSync(path.join(packageDir, 'dist', 'cli.js'))) {
    throw new Error('Isolated package is missing dist/cli.js.');
  }
  if (!fs.existsSync(path.join(packageDir, 'dist', 'web', 'index.html'))) {
    throw new Error('Isolated package is missing dist/web/index.html.');
  }
  if (!fs.existsSync(path.join(packageDir, 'node_modules', 'fastify'))) {
    throw new Error('Isolated package is missing production dependency fastify.');
  }
  const isolatedModules = fs.realpathSync(path.join(packageDir, 'node_modules'));
  const repoModules = path.join(repoRoot, 'node_modules');
  if (fs.existsSync(repoModules) && isolatedModules === fs.realpathSync(repoModules)) {
    throw new Error('Isolated package resolved node_modules back to the repository.');
  }
}

export async function runIsolatedWebArtifactSmoke() {
  if (!fs.existsSync(repoCli)) {
    throw new Error('Isolated Web artifact smoke requires dist/cli.js. Run pnpm build first.');
  }
  if (!fs.existsSync(repoWebIndex)) {
    throw new Error(
      'Isolated Web artifact smoke requires dist/web/index.html. Run pnpm build first.',
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-web-isolated-'));
  const packageDir = path.join(tempRoot, 'package');
  const cwd = path.join(tempRoot, 'cwd');
  const workspace = path.join(tempRoot, 'workspace');
  const pnpmEnv = buildIsolatedPnpmEnv(process.env);
  const webEnv = buildIsolatedWebEnv(process.env, ISOLATED_WEB_SMOKE_KEY);
  let runningChild;
  try {
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const decoy = `${JSON.stringify({ model: 'cwd-decoy-model' })}\n`;
    assertTextHasNoSecrets(decoy, [ISOLATED_WEB_SMOKE_KEY], 'Isolated cwd decoy config');
    fs.writeFileSync(path.join(cwd, 'echo.config.json'), decoy, 'utf8');
    copyPublishTree(packageDir);
    installIsolatedProdDeps(packageDir, pnpmEnv, process.env);
    assertIsolatedTree(packageDir);

    const isolatedCli = path.join(packageDir, 'dist', 'cli.js');
    runningChild = spawn(
      process.execPath,
      [isolatedCli, 'web', '--no-open', '--workspace', workspace, '--port', '0'],
      {
        cwd,
        env: webEnv,
        shell: false,
        windowsHide: true,
      },
    );
    const child = runningChild;
    const started = await waitForBootstrap(child, 20_000);
    const leakHints = [ISOLATED_WEB_SMOKE_KEY, os.homedir()];
    assertTextHasNoSecrets(
      `${started.stdout}\n${started.stderr}`,
      leakHints,
      'Isolated Web console',
    );

    const origin = `http://127.0.0.1:${started.port}`;
    const host = `127.0.0.1:${started.port}`;
    const page = await fetch(origin, { headers: { host, connection: 'close' } });
    if (page.status !== 200) {
      child.kill('SIGTERM');
      throw new Error(`Isolated static page expected 200, got ${String(page.status)}.`);
    }
    const html = await page.text();
    if (!html.includes('ECHO Coding Harness') || !html.includes('id="root"')) {
      child.kill('SIGTERM');
      throw new Error('Isolated static page did not contain the React shell root.');
    }
    assertTextHasNoSecrets(html, leakHints, 'Isolated static page');

    const bootstrap = await fetch(`${origin}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: {
        host,
        origin,
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({ token: started.token }),
    });
    if (bootstrap.status !== 204) {
      child.kill('SIGTERM');
      throw new Error(`Isolated bootstrap expected 204, got ${String(bootstrap.status)}.`);
    }
    const setCookie = bootstrap.headers.getSetCookie?.() ?? [];
    const cookieHeader = setCookie[0] ?? bootstrap.headers.get('set-cookie') ?? '';
    if (!cookieHeader.includes('HttpOnly') || !cookieHeader.includes('SameSite=Strict')) {
      child.kill('SIGTERM');
      throw new Error('Isolated bootstrap cookie missing HttpOnly SameSite=Strict attributes.');
    }
    const cookieMatch = /echo_web=([^;]+)/u.exec(cookieHeader);
    if (cookieMatch?.[1] === undefined) {
      child.kill('SIGTERM');
      throw new Error('Isolated bootstrap cookie value was missing.');
    }

    const snapshot = await fetch(`${origin}/api/v1/bootstrap`, {
      headers: {
        host,
        cookie: `echo_web=${cookieMatch[1]}`,
        connection: 'close',
      },
    });
    if (snapshot.status !== 200) {
      child.kill('SIGTERM');
      throw new Error(`Isolated bootstrap snapshot expected 200, got ${String(snapshot.status)}.`);
    }
    const payload = await snapshot.json();
    assertTextHasNoSecrets(JSON.stringify(payload), leakHints, 'Isolated bootstrap snapshot');

    const created = await fetch(`${origin}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        host,
        origin,
        cookie: `echo_web=${cookieMatch[1]}`,
        'content-type': 'application/json',
        'x-echo-request-id': 'req_isolated_smoke1',
        connection: 'close',
      },
      body: JSON.stringify({}),
    });
    if (created.status !== 201) {
      child.kill('SIGTERM');
      throw new Error(`Isolated session create expected 201, got ${String(created.status)}.`);
    }
    const createdPayload = await created.json();
    if (
      typeof createdPayload !== 'object' ||
      createdPayload === null ||
      typeof createdPayload.data?.session?.id !== 'string'
    ) {
      child.kill('SIGTERM');
      throw new Error('Isolated session create did not return a SessionView DTO.');
    }

    const exitCode = await stopChild(child);
    if (exitCode !== 0) {
      throw new Error(
        `Isolated Web console expected exit 0 after stdin-end, got ${String(exitCode)}.`,
      );
    }

    process.stdout.write('Isolated Web artifact smoke check passed.\n');
  } finally {
    try {
      runningChild?.kill();
    } catch {
      // Child may already have exited.
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      process.stderr.write(
        'Isolated Web artifact smoke: temp cleanup failed (os.tmpdir tree only; repo and user profile were not deleted).\n',
      );
    }
  }
}

const invokedAsCli =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).toLocaleLowerCase('en-US') ===
    path.resolve(process.argv[1]).toLocaleLowerCase('en-US');

if (invokedAsCli) {
  await runIsolatedWebArtifactSmoke();
}
