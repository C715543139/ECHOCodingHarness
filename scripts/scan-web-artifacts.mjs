import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertOutputSafe,
  POSITIVE_IDENTITY_SAMPLES,
  POSITIVE_SECRET_SAMPLES,
  scanText,
} from './scan-lib.mjs';

export const MAX_WEB_ARTIFACT_BYTES = 8 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.css',
  '.har',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.log',
  '.map',
  '.md',
  '.txt',
  '.webmanifest',
  '.xml',
  '.yml',
  '.yaml',
]);

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.webm']);
const ARCHIVE_EXTENSIONS = new Set(['.zip']);

const REASONING_LEAK =
  /\b(?:model\.reasoning|reasoning_delta|reasoningContent|reasoning_details|reasoningDetails)\b/u;

const ABSOLUTE_PATH_LINE = /(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/]|\/(?:home|Users)\/)/u;

function extractPrintableStrings(buffer) {
  const text = buffer.toString('latin1');
  return (text.match(/[\u0020-\u007E]{6,}/gu) ?? []).join('\n');
}

function addFinding(findings, finding) {
  const exists = findings.some(
    (current) =>
      current.rule === finding.rule &&
      current.relativePath === finding.relativePath &&
      current.line === finding.line,
  );
  if (!exists) {
    findings.push(finding);
  }
}

function collectReasoningFindings(relativePath, text, findings) {
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (REASONING_LEAK.test(line)) {
      addFinding(findings, {
        scanner: 'privacy',
        rule: 'reasoning-leak',
        relativePath,
        line: index + 1,
      });
    }
  }
}

function collectAbsolutePathFindings(relativePath, text, findings) {
  const lines = text.split(/\r?\n/u);
  const home = os.homedir();
  for (const [index, line] of lines.entries()) {
    const hit = ABSOLUTE_PATH_LINE.test(line) || (home.length > 0 && line.includes(home));
    if (hit) {
      addFinding(findings, {
        scanner: 'privacy',
        rule: 'absolute-path',
        relativePath,
        line: index + 1,
      });
    }
  }
}

async function walkFiles(root) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await visit(root);
  return files;
}

function fileLevelFinding(rule, relativePath) {
  return {
    scanner: 'privacy',
    rule,
    relativePath,
    line: 1,
  };
}

export async function scanWebArtifacts(root) {
  const files = await walkFiles(root);
  const findings = [];
  for (const absolutePath of files) {
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    const extension = path.extname(absolutePath).toLocaleLowerCase('en-US');
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      addFinding(findings, fileLevelFinding('unscannable-artifact', relativePath));
      continue;
    }
    if (!info.isFile()) {
      continue;
    }
    if (info.size > MAX_WEB_ARTIFACT_BYTES) {
      addFinding(findings, fileLevelFinding('oversized-artifact', relativePath));
    }
    if (ARCHIVE_EXTENSIONS.has(extension)) {
      addFinding(findings, fileLevelFinding('unscannable-archive', relativePath));
      continue;
    }
    if (info.size > MAX_WEB_ARTIFACT_BYTES) {
      continue;
    }
    const buffer = await readFile(absolutePath);
    let text = '';
    if (TEXT_EXTENSIONS.has(extension) || !buffer.includes(0)) {
      text = buffer.toString('utf8');
    }
    if (BINARY_EXTENSIONS.has(extension)) {
      text = `${text}\n${extractPrintableStrings(buffer)}`;
    }
    findings.push(...scanText('secrets', relativePath, text));
    findings.push(...scanText('identity', relativePath, text));
    collectReasoningFindings(relativePath, text, findings);
    collectAbsolutePathFindings(relativePath, text, findings);
  }
  return findings;
}

function formatPrivacyFindings(findings) {
  if (findings.length === 0) {
    return 'web-artifact-scan: passed\n';
  }
  const lines = [`web-artifact-scan: ${String(findings.length)} finding(s)`];
  for (const finding of findings) {
    lines.push(`  ${finding.relativePath}:${String(finding.line)}  rule=${finding.rule}`);
  }
  return `${lines.join('\n')}\n`;
}

function splitSample(parts) {
  return parts.join('');
}

async function runSelfTest() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'echo-web-artifact-scan-'));
  try {
    await writeFile(
      path.join(tempRoot, 'error-context.md'),
      `${Object.values(POSITIVE_SECRET_SAMPLES).join('\n')}\n${splitSample(['reasoning', '_', 'details'])}\n`,
      'utf8',
    );
    await writeFile(path.join(tempRoot, 'trace.zip'), Buffer.from('PK\u0003\u0004trace', 'latin1'));
    const large = await open(path.join(tempRoot, 'huge.png'), 'w');
    await large.truncate(MAX_WEB_ARTIFACT_BYTES + 1);
    await large.close();
    await writeFile(
      path.join(tempRoot, 'paths.txt'),
      [
        splitSample(['D:', '\\', 'echo-artifact-scan', '\\', 'notes.txt']),
        splitSample(['\\\\', 'fileserver', '\\', 'share', '\\', 'notes.txt']),
        splitSample(['/', 'home', '/', 'runner', '/', 'project']),
        splitSample(['/', 'Users', '/', 'runner', '/', 'project']),
        `${Object.values(POSITIVE_IDENTITY_SAMPLES).join('\n')}`,
        'model.reasoning\nreasoningContent\n',
      ].join('\n'),
      'utf8',
    );
    const findings = await scanWebArtifacts(tempRoot);
    const rules = new Set(findings.map((finding) => finding.rule));
    const names = new Set(findings.map((finding) => finding.relativePath));
    const output = formatPrivacyFindings(findings);
    const forbiddenPaths = [
      splitSample(['D:', '\\', 'echo-artifact-scan']),
      splitSample(['\\\\', 'fileserver']),
      splitSample(['/', 'home', '/', 'runner']),
      splitSample(['/', 'Users', '/', 'runner']),
    ];
    assertOutputSafe(output, [
      ...Object.values(POSITIVE_SECRET_SAMPLES),
      ...Object.values(POSITIVE_IDENTITY_SAMPLES),
      ...forbiddenPaths,
      os.homedir(),
    ]);
    const requiredRules = [
      'openai-key',
      'email',
      'reasoning-leak',
      'absolute-path',
      'unscannable-archive',
      'oversized-artifact',
    ];
    const missing = requiredRules.filter((rule) => !rules.has(rule));
    if (missing.length > 0 || !names.has('error-context.md') || !names.has('trace.zip')) {
      process.stdout.write('web-artifact-scan self-test: failed\n  missing expected rules\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('web-artifact-scan self-test: passed\n');
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

export async function runWebArtifactScanCli(args) {
  const selfTest = args.includes('--self-test');
  if (selfTest) {
    await runSelfTest();
    return;
  }

  const rootFlag = args.indexOf('--root');
  const root = rootFlag >= 0 && args[rootFlag + 1] !== undefined ? args[rootFlag + 1] : undefined;
  if (root === undefined) {
    process.stdout.write('web-artifact-scan: failed\n  --root is required\n');
    process.exitCode = 1;
    return;
  }
  const findings = await scanWebArtifacts(root);
  const output = formatPrivacyFindings(findings);
  try {
    assertOutputSafe(output, [
      ...Object.values(POSITIVE_SECRET_SAMPLES),
      ...Object.values(POSITIVE_IDENTITY_SAMPLES),
      os.homedir(),
    ]);
  } catch {
    process.stdout.write('web-artifact-scan: failed\n  output sanitization failed\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(output);
  process.exitCode = findings.length === 0 ? 0 : 1;
}

const invokedAsCli =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).toLocaleLowerCase('en-US') ===
    path.resolve(process.argv[1]).toLocaleLowerCase('en-US');

if (invokedAsCli) {
  await runWebArtifactScanCli(process.argv.slice(2));
}
