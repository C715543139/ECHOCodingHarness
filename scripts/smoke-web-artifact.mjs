import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const repoWebIndex = fileURLToPath(new URL('../dist/web/index.html', import.meta.url));

if (!fs.existsSync(repoCli)) {
  throw new Error('Web artifact smoke requires dist/cli.js. Run pnpm build first.');
}
if (!fs.existsSync(repoWebIndex)) {
  throw new Error('Web artifact smoke requires dist/web/index.html. Run pnpm build first.');
}

const artifactConfigDir = path.join(path.dirname(repoCli), 'config');
const artifactConfig = path.join(artifactConfigDir, 'echo.config.json');
const hadConfig = fs.existsSync(artifactConfig);
const configBackup = hadConfig ? fs.readFileSync(artifactConfig) : undefined;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-web-smoke-'));
const cwd = path.join(tempRoot, 'cwd');
const workspace = path.join(tempRoot, 'workspace');
const smokeKey = 'web-artifact-smoke-key';

const BOOTSTRAP_URL = /http:\/\/127\.0\.0\.1:(\d+)\/#bootstrap=([0-9a-f]{16,128})/u;

function redact(text) {
  return text.replaceAll(smokeKey, '<redacted>');
}

function combined(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
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
            `Web console did not print a loopback bootstrap URL within ${String(timeoutMs)}ms.`,
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
              `Web console exited ${String(code)} before printing a bootstrap URL:\n${redact(combined({ stdout, stderr }))}`,
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
      reject(new Error('Web console did not exit within the 10s shutdown window.'));
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

try {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(artifactConfigDir, { recursive: true });
  fs.writeFileSync(
    artifactConfig,
    `${JSON.stringify({
      baseUrl: 'https://provider.example/v1',
      model: 'fake-model',
      modelCatalog: { source: 'discover' },
      safetyMode: 'balanced',
    })}\n`,
    'utf8',
  );

  const child = spawn(
    process.execPath,
    [repoCli, 'web', '--no-open', '--workspace', workspace, '--port', '0'],
    {
      cwd,
      env: {
        ...process.env,
        ECHO_API_KEY: smokeKey,
        NO_COLOR: '1',
      },
      windowsHide: true,
    },
  );

  const started = await waitForBootstrap(child, 20_000);
  if (started.stdout.includes(smokeKey) || started.stderr.includes(smokeKey)) {
    child.kill('SIGTERM');
    throw new Error('Web console leaked the API key.');
  }
  if (started.stdout.includes(os.homedir()) || started.stderr.includes(os.homedir())) {
    child.kill('SIGTERM');
    throw new Error('Web console leaked a personal home path.');
  }

  const origin = `http://127.0.0.1:${started.port}`;
  const host = `127.0.0.1:${started.port}`;
  const page = await fetch(origin, { headers: { host, connection: 'close' } });
  if (page.status !== 200) {
    child.kill('SIGTERM');
    throw new Error(`Packaged static page expected 200, got ${String(page.status)}.`);
  }
  const html = await page.text();
  if (!html.includes('ECHO Coding Harness') || !html.includes('id="root"')) {
    child.kill('SIGTERM');
    throw new Error('Packaged static page did not contain the React shell root.');
  }
  if (html.includes(smokeKey) || html.includes('reasoning')) {
    child.kill('SIGTERM');
    throw new Error('Packaged static page contained a secret or reasoning marker.');
  }

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
    throw new Error(`Bootstrap expected 204, got ${String(bootstrap.status)}.`);
  }
  const setCookie = bootstrap.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookie[0] ?? bootstrap.headers.get('set-cookie') ?? '';
  if (!cookieHeader.includes('HttpOnly') || !cookieHeader.includes('SameSite=Strict')) {
    child.kill('SIGTERM');
    throw new Error('Bootstrap cookie missing HttpOnly SameSite=Strict attributes.');
  }
  const cookieMatch = /echo_web=([^;]+)/u.exec(cookieHeader);
  if (cookieMatch?.[1] === undefined) {
    child.kill('SIGTERM');
    throw new Error('Bootstrap cookie value was missing.');
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
    throw new Error(
      `Authenticated bootstrap snapshot expected 200, got ${String(snapshot.status)}.`,
    );
  }
  const payload = await snapshot.json();
  const serialized = JSON.stringify(payload);
  if (serialized.includes(smokeKey) || serialized.includes(os.homedir())) {
    child.kill('SIGTERM');
    throw new Error('Bootstrap snapshot leaked a secret or personal path.');
  }
  if (payload?.data?.workspace?.name === undefined) {
    child.kill('SIGTERM');
    throw new Error('Bootstrap snapshot did not include a workspace display name.');
  }

  const exitCode = await stopChild(child);
  if (exitCode !== 0) {
    throw new Error(`Web console expected exit 0 after SIGTERM, got ${String(exitCode)}.`);
  }

  process.stdout.write('Web artifact smoke check passed.\n');
} finally {
  if (configBackup !== undefined) {
    fs.mkdirSync(artifactConfigDir, { recursive: true });
    fs.writeFileSync(artifactConfig, configBackup);
  } else if (fs.existsSync(artifactConfigDir)) {
    fs.rmSync(artifactConfigDir, { recursive: true, force: true });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
