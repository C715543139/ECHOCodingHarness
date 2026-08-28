import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const SKIP_DIRECTORY_NAMES = new Set([
  '.echo',
  '.git',
  '.idea',
  '.pnpm-store',
  '.vscode',
  'coverage',
  'dist',
  'node_modules',
]);

const SKIP_FILE_NAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
const SKIP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.pdf',
  '.zip',
]);

const MAX_FILE_BYTES = 512 * 1024;

const PLACEHOLDER_VALUE =
  /^(?:<[^>\n]{0,80}>|\$\{[^}\n]{0,80}\}|your[-_].+|changeme|placeholder|example(?:[-_].+)?|redacted|dummy|fake|secret|password|token|key|test(?:[-_]?key)?|xxx+|[*•x]{4,}|)$/iu;

const DOCUMENTATION_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

const ALLOWED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.test',
  'example.invalid',
  'invalid',
  'localhost',
  'test',
]);

const ALLOWED_PROFILE_NAMES = new Set([
  'all users',
  'default',
  'default user',
  'fixture',
  'fixtur~1',
  'private-name',
  'private-user',
  'public',
  'runner',
  'user',
  'username',
]);

export const POSITIVE_SECRET_SAMPLES = Object.freeze({
  'openai-key': ['sk-', 'testpos_', 'abcdefghijklmnopqrstuvwxyz012345'].join(''),
  'github-token': ['ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join(''),
  'aws-access-key': ['AKIA', 'TESTPOSITIVE0001'].join(''),
  'private-key': [
    '-----BEGIN ',
    'RSA PRIVATE KEY-----\nMIIBOgPLACEHOLDER\n-----END RSA PRIVATE KEY-----',
  ].join(''),
  'assigned-secret': ['client_secret=', 'abcdefghijklmnopqrstuvwxyz0123'].join(''),
});

export const POSITIVE_IDENTITY_SAMPLES = Object.freeze({
  email: ['alice.zhang.eval', '@', 'gmail.com'].join(''),
  'windows-profile': ['C:\\Users\\', 'ZhangWei', '\\Documents\\notes.txt'].join(''),
});

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function relativeToRoot(root, absolutePath) {
  return toPosix(path.relative(root, absolutePath));
}

function shouldSkipName(name) {
  return SKIP_DIRECTORY_NAMES.has(name) || SKIP_FILE_NAMES.has(name);
}

function isSkippedFile(filePath) {
  const extension = path.extname(filePath).toLocaleLowerCase('en-US');
  return SKIP_FILE_NAMES.has(path.basename(filePath)) || SKIP_EXTENSIONS.has(extension);
}

function looksLikePlaceholder(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_VALUE.test(trimmed)) return true;
  if (/^sk-+x+$/iu.test(trimmed)) return true;
  if (/^ghp_x+$/iu.test(trimmed)) return true;
  if (trimmed === DOCUMENTATION_AWS_KEY) return true;
  return false;
}

function addFinding(findings, scanner, rule, relativePath, line) {
  findings.push({ scanner, rule, relativePath, line });
}

function collectSecretFindings(relativePath, text, findings) {
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (/\bsk-[A-Za-z0-9_-]{20,}\b/u.test(line) && !/sk-+x+\b/iu.test(line)) {
      addFinding(findings, 'secrets', 'openai-key', relativePath, lineNumber);
    }
    if (/\bghp_[A-Za-z0-9]{36}\b/u.test(line) && !/\bghp_x{36}\b/iu.test(line)) {
      addFinding(findings, 'secrets', 'github-token', relativePath, lineNumber);
    }
    if (/\bAKIA[0-9A-Z]{16}\b/u.test(line) && !line.includes(DOCUMENTATION_AWS_KEY)) {
      addFinding(findings, 'secrets', 'aws-access-key', relativePath, lineNumber);
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(line)) {
      addFinding(findings, 'secrets', 'private-key', relativePath, lineNumber);
    }
    for (const match of line.matchAll(
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password)\s*[=:]\s*['"]([^'"]{20,})['"]/giu,
    )) {
      const value = match[1] ?? '';
      if (!looksLikePlaceholder(value) && !value.startsWith('${')) {
        addFinding(findings, 'secrets', 'assigned-secret', relativePath, lineNumber);
      }
    }
    for (const match of line.matchAll(
      /(?:^|[\s"'`])(?:[A-Za-z0-9_.]*[_-])?(?:api[_-]?key|secret|password|token)\s*=\s*([^\s"'`#]{20,})/giu,
    )) {
      const value = match[1] ?? '';
      if (
        !looksLikePlaceholder(value) &&
        !value.startsWith('${') &&
        !value.includes('process.env') &&
        !value.includes('ENV_KEYS')
      ) {
        addFinding(findings, 'secrets', 'assigned-secret', relativePath, lineNumber);
      }
    }
    for (const match of line.matchAll(/\bBearer\s+([A-Za-z0-9._~+/=-]{24,})/gu)) {
      const token = match[1] ?? '';
      if (!looksLikePlaceholder(token) && token !== '[REDACTED]') {
        addFinding(findings, 'secrets', 'bearer-token', relativePath, lineNumber);
      }
    }
    for (const match of line.matchAll(/https?:\/\/[^/\s:@]+:([^/\s:@]{16,})@/gu)) {
      const password = match[1] ?? '';
      if (!looksLikePlaceholder(password)) {
        addFinding(findings, 'secrets', 'url-credentials', relativePath, lineNumber);
      }
    }
  }
}

function emailDomain(address) {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLocaleLowerCase('en-US');
}

function collectIdentityFindings(relativePath, text, findings) {
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    for (const match of line.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu)) {
      const address = match[0];
      const domain = emailDomain(address);
      const rootDomain = domain.split('.').slice(-2).join('.');
      if (!ALLOWED_EMAIL_DOMAINS.has(domain) && !ALLOWED_EMAIL_DOMAINS.has(rootDomain)) {
        addFinding(findings, 'identity', 'email', relativePath, lineNumber);
      }
    }
    for (const match of line.matchAll(/[A-Za-z]:\\Users\\([A-Za-z0-9._~ -]+)/giu)) {
      const profile = (match[1] ?? '').toLocaleLowerCase('en-US');
      if (!ALLOWED_PROFILE_NAMES.has(profile)) {
        addFinding(findings, 'identity', 'windows-profile', relativePath, lineNumber);
      }
    }
    for (const match of line.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/gu)) {
      const profile = (match[1] ?? '').toLocaleLowerCase('en-US');
      if (!ALLOWED_PROFILE_NAMES.has(profile) && profile !== 'shared' && profile !== 'guest') {
        addFinding(findings, 'identity', 'unix-profile', relativePath, lineNumber);
      }
    }
  }
}

export function scanText(scanner, relativePath, text) {
  const findings = [];
  if (scanner === 'secrets') collectSecretFindings(relativePath, text, findings);
  else collectIdentityFindings(relativePath, text, findings);
  return findings;
}

async function listGitFiles(root) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'buffer',
    windowsHide: true,
  });
  if (result.status !== 0 || result.stdout === null) return undefined;
  const names = [];
  for (const chunk of result.stdout.toString('utf8').split('\0')) {
    if (chunk.length > 0) names.push(chunk);
  }
  return names;
}

async function walkFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipName(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile() && !isSkippedFile(absolutePath)) files.push(absolutePath);
    }
  }

  await visit(root);
  return files;
}

export async function listScanTargets(root) {
  const gitFiles = await listGitFiles(root);
  if (gitFiles !== undefined) {
    return gitFiles
      .filter((relativePath) => {
        const parts = relativePath.split(/[\\/]/u);
        return !parts.some((part) => shouldSkipName(part)) && !isSkippedFile(relativePath);
      })
      .map((relativePath) => path.join(root, relativePath));
  }
  return walkFiles(root);
}

export async function scanPath(scanner, root) {
  const files = await listScanTargets(root);
  const findings = [];
  for (const absolutePath of files) {
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
    const buffer = await readFile(absolutePath);
    if (buffer.includes(0)) continue;
    const relativePath = relativeToRoot(root, absolutePath);
    findings.push(...scanText(scanner, relativePath, buffer.toString('utf8')));
  }
  return findings;
}

export function formatFindings(scanner, findings) {
  const label = scanner === 'secrets' ? 'secret-scan' : 'identity-scan';
  if (findings.length === 0) return `${label}: passed\n`;
  const lines = [`${label}: ${String(findings.length)} finding(s)`];
  for (const finding of findings) {
    lines.push(`  ${finding.relativePath}:${String(finding.line)}  rule=${finding.rule}`);
  }
  return `${lines.join('\n')}\n`;
}

export function assertOutputSafe(output, forbidden) {
  const normalized = output.toLocaleLowerCase('en-US');
  for (const value of forbidden) {
    if (value.trim().length === 0) continue;
    if (normalized.includes(value.toLocaleLowerCase('en-US'))) {
      throw new Error('Scan output leaked a forbidden value.');
    }
  }
  if (
    /[A-Za-z]:\\Users\\(?!fixture|private-user|private-name|runner|public|default)/iu.test(output)
  ) {
    throw new Error('Scan output leaked a personal Windows profile path.');
  }
}

export async function writePositiveSamples(kind, directory) {
  const samples = kind === 'secrets' ? POSITIVE_SECRET_SAMPLES : POSITIVE_IDENTITY_SAMPLES;
  await writeFile(
    path.join(directory, 'positive.txt'),
    Object.values(samples).join('\n') + '\n',
    'utf8',
  );
  return samples;
}

export async function runSelfTest(scanner) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `echo-scan-${scanner}-`));
  try {
    const samples = await writePositiveSamples(scanner, tempRoot);
    const positiveFindings = await scanPath(scanner, tempRoot);
    const expectedRules = new Set(Object.keys(samples));
    const foundRules = new Set(positiveFindings.map((finding) => finding.rule));
    const missing = [...expectedRules].filter((rule) => !foundRules.has(rule));
    const repoFindings = await scanPath(scanner, REPO_ROOT);
    const output = formatFindings(scanner, [...positiveFindings, ...repoFindings]);
    assertOutputSafe(output, [
      ...Object.values(samples),
      os.homedir(),
      process.env.USERPROFILE ?? '',
      process.env.USERNAME ?? '',
    ]);
    if (missing.length > 0) {
      return {
        ok: false,
        output: `${scanner === 'secrets' ? 'secret-scan' : 'identity-scan'} self-test: failed\n  missing ${missing.map((rule) => `rule=${rule}`).join(', ')} on generated positive sample\n`,
      };
    }
    if (repoFindings.length > 0) {
      return {
        ok: false,
        output: formatFindings(scanner, repoFindings),
      };
    }
    const label = scanner === 'secrets' ? 'secret-scan' : 'identity-scan';
    return {
      ok: true,
      output: `${label} self-test: passed (${String(expectedRules.size)} positive, repo negative)\n`,
    };
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

export async function runScanCli(scanner, args) {
  const selfTest = args.includes('--self-test');
  if (selfTest) {
    const result = await runSelfTest(scanner);
    process.stdout.write(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const rootFlag = args.indexOf('--root');
  const root = rootFlag >= 0 && args[rootFlag + 1] !== undefined ? args[rootFlag + 1] : REPO_ROOT;
  const findings = await scanPath(scanner, root);
  const output = formatFindings(scanner, findings);
  const forbidden = [
    ...Object.values(POSITIVE_SECRET_SAMPLES),
    ...Object.values(POSITIVE_IDENTITY_SAMPLES),
    os.homedir(),
  ];
  try {
    assertOutputSafe(output, forbidden);
  } catch {
    process.stdout.write(
      `${scanner === 'secrets' ? 'secret-scan' : 'identity-scan'}: failed\n  output sanitization failed\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(output);
  process.exitCode = findings.length === 0 ? 0 : 1;
}
