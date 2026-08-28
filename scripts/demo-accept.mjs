import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const demoRoot = path.join(repoRoot, 'fixtures', 'demo');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const runs = 3;
const timeoutMs = 180_000;
const TURN_STATUS = /^(DONE|FAIL|LIMIT|CANCELLED)\s+(\S+)/gmu;

function present(name) {
  return Boolean(process.env[name]?.trim());
}

async function loadEnvFile(filePath) {
  const source = await readFile(filePath, 'utf8');
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
    if (process.env[name] === undefined || process.env[name] === '') {
      process.env[name] = value;
    }
  }
}

function secretConfigured() {
  return present('ECHO_API_KEY') && present('ECHO_BASE_URL') && present('ECHO_MODEL');
}

async function resetFixture() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'demo-reset.mjs')], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`demo reset failed with exit ${String(code)}`));
    });
  });
}

export function analyzeDemoOutput(stdout, stderr, secret) {
  const combined = `${stdout}\n${stderr}`;
  const leak = secret.length > 0 && combined.includes(secret);
  const userPath = /[A-Za-z]:\\Users\\/u.test(combined) || /\/Users\/[^/\s]+/u.test(combined);
  const reasoning = /\b(?:reasoning|analysis)\s*[:=]\s*\S/iu.test(combined);
  const failedTest = /FAIL\s+exit\s+[1-9]/u.test(stderr) || /\d+ tests? failed/u.test(stderr);
  const applyPatch = /TOOL\s+apply_patch/u.test(stderr);
  const passingRetest = /OK\s+exit\s+0/u.test(stderr);
  const done = /^DONE\s+completed/mu.test(stderr);
  const step = /STEP\s+\d+/u.test(stderr);
  const stop = [...stderr.matchAll(TURN_STATUS)].at(-1);
  return {
    leak,
    userPath,
    reasoning,
    failedTest,
    applyPatch,
    passingRetest,
    done,
    step,
    stopReason: stop?.[2] ?? 'unknown',
    story:
      step && failedTest && applyPatch && passingRetest && done && !leak && !userPath && !reasoning,
  };
}

function runOnce(goal) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        cliPath,
        'run',
        goal,
        '--workspace',
        demoRoot,
        '--safety-mode',
        'balanced',
        '--non-interactive',
        '--no-color',
        '--max-steps',
        '12',
      ],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.normalize(fileURLToPath(import.meta.url)) === path.normalize(path.resolve(entry));
}

if (isMainModule()) {
  const envFile = process.env.ECHO_ENV_FILE ?? path.join(repoRoot, '.env.test');
  try {
    await loadEnvFile(envFile);
  } catch {
    // Environment may already be provided by the caller.
  }

  if (!secretConfigured()) {
    process.stderr.write(
      'Demo acceptance skipped: ECHO_BASE_URL, ECHO_API_KEY, and ECHO_MODEL are required.\n',
    );
    process.exit(2);
  }

  const goal = (await readFile(path.join(demoRoot, 'prompt.txt'), 'utf8')).trim();
  const secret = process.env.ECHO_API_KEY ?? '';
  const results = [];

  for (let index = 1; index <= runs; index += 1) {
    await resetFixture();
    const outcome = await runOnce(goal);
    const privacy = analyzeDemoOutput(outcome.stdout, outcome.stderr, secret);
    const stats = {
      run: index,
      ok: outcome.exitCode === 0 && privacy.story,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      stopReason: privacy.stopReason,
      failedTest: privacy.failedTest,
      applyPatch: privacy.applyPatch,
      passingRetest: privacy.passingRetest,
      privacy: !privacy.leak && !privacy.userPath && !privacy.reasoning,
    };
    results.push(stats);
    process.stdout.write(
      `run ${String(index)}: ${stats.ok ? 'pass' : 'fail'} · ${String(stats.durationMs)}ms · exit ${String(stats.exitCode)} · stopReason ${stats.stopReason} · failTest ${String(stats.failedTest)} · apply_patch ${String(stats.applyPatch)} · retest ${String(stats.passingRetest)} · privacy ${String(stats.privacy)}\n`,
    );
  }

  const passed = results.filter((item) => item.ok).length;
  process.stdout.write(`demo acceptance: ${String(passed)}/${String(runs)} passed\n`);
  process.exit(passed === runs ? 0 : 1);
}
