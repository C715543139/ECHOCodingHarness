import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runGoal } from '../../src/cli/run.js';
import type { ModelToolCall } from '../../src/contracts/index.js';
import { FakeProvider, type FakeProviderResponse } from '../../src/provider/index.js';

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const fixtureRoot = path.join(repositoryRoot, 'fixtures', 'p3-pdf-demo');

const manifest = `${JSON.stringify(
  {
    schemaVersion: 1,
    id: 'pdf-reader',
    version: '1.0.0',
    entry: 'index.mjs',
    selfTest: 'extension.test.mjs',
    tools: [
      {
        name: 'read_pdf',
        description: 'Extract bounded text from a PDF file in the current workspace.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1 } },
        },
      },
    ],
  },
  null,
  2,
)}\n`;

const extensionSource = String.raw`import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

function decodePdfString(value) {
  return value.replace(/\\([\\()])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
}

export function extractPdfText(buffer) {
  const binary = buffer.toString('latin1');
  const parts = [];
  let cursor = 0;
  while (true) {
    const marker = binary.indexOf('stream', cursor);
    if (marker < 0) break;
    const lineEnd = binary.indexOf('\n', marker);
    const end = binary.indexOf('endstream', lineEnd + 1);
    if (lineEnd < 0 || end < 0) break;
    let streamEnd = end;
    while (streamEnd > lineEnd && (binary[streamEnd - 1] === '\r' || binary[streamEnd - 1] === '\n')) streamEnd -= 1;
    const dictionaryStart = binary.lastIndexOf('<<', marker);
    const dictionary = dictionaryStart < 0 ? '' : binary.slice(dictionaryStart, marker);
    let content = buffer.subarray(lineEnd + 1, streamEnd);
    if (dictionary.includes('/FlateDecode')) content = inflateSync(content);
    parts.push(content.toString('latin1'));
    cursor = end + 9;
  }
  const lines = [];
  for (const content of parts) {
    const pattern = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    for (const match of content.matchAll(pattern)) lines.push(decodePdfString(match[1]));
  }
  return lines.join('\n').trim();
}

async function readPdf(input, context) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'path') || typeof input.path !== 'string' || input.path.length === 0) {
    return { status: 'failed', summary: 'path must be a non-empty string.', error: { category: 'invalid_tool_input', code: 'INVALID_PDF_PATH', message: 'path must be a non-empty string.', retryable: false }, truncated: false };
  }
  const root = path.resolve(context.workspaceRoot);
  const target = path.resolve(root, input.path);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return { status: 'failed', summary: 'PDF path is outside the workspace.', error: { category: 'workspace_violation', code: 'PDF_PATH_OUTSIDE_WORKSPACE', message: 'PDF path is outside the workspace.', retryable: false }, truncated: false };
  }
  const buffer = await fs.readFile(target);
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('File is not a PDF.');
  const text = extractPdfText(buffer);
  const bounded = text.slice(0, context.limits.maxOutputChars);
  return { status: 'completed', summary: 'Extracted PDF text.', data: { path: input.path, text: bounded }, truncated: bounded.length < text.length };
}

export const handlers = { read_pdf: readPdf };
`;

const selfTestSource = String.raw`import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractPdfText, handlers } from './index.mjs';

assert.deepEqual(Object.keys(handlers), ['read_pdf']);
const content = Buffer.from('BT (synthetic requirement) Tj ET', 'ascii');
const compressed = deflateSync(content);
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n4 0 obj\n<< /Filter /FlateDecode >>\nstream\n', 'ascii'), compressed, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'ascii')]);
assert.equal(extractPdfText(pdf), 'synthetic requirement');
console.log('pdf-reader self-test passed');
`;

function tool(call: ModelToolCall): FakeProviderResponse {
  return {
    events: [
      { type: 'tool_call', call },
      { type: 'completed', finishReason: 'tool_calls' },
    ],
  };
}

function text(value: string): FakeProviderResponse {
  return {
    events: [
      { type: 'text_delta', delta: value },
      { type: 'completed', finishReason: 'stop' },
    ],
  };
}

async function copyFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-p3-pdf-demo-'));
  temporaryDirectories.push(root);
  await fs.cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function writeConfig(artifactRoot: string): Promise<void> {
  await fs.mkdir(path.join(artifactRoot, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(artifactRoot, 'config', 'echo.config.json'),
    `${JSON.stringify({ baseUrl: 'https://provider.example/v1', model: 'fake-model', modelCatalog: { source: 'manual', models: ['fake-model'] }, safetyMode: 'full-access', maxSteps: 16 })}\n`,
  );
}

async function protectedHashes(root: string): Promise<Record<string, string>> {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'evidence-lock.json'), 'utf8')) as {
    files: Record<string, string>;
  };
  const { createHash } = await import('node:crypto');
  const actual: Record<string, string> = {};
  for (const relativePath of Object.keys(lock.files)) {
    const content = await fs.readFile(path.join(root, ...relativePath.split('/')));
    actual[relativePath] = createHash('sha256').update(content).digest('hex');
  }
  return actual;
}

async function independentTest(root: string): Promise<number> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'test/score-summary.test.mjs'], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('P3 synthetic PDF demo', () => {
  it('proves the failure, authors and reuses a workspace PDF extension, fixes, and independently verifies', async () => {
    const root = await copyFixture();
    const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-p3-artifact-'));
    temporaryDirectories.push(artifactRoot);
    await writeConfig(artifactRoot);
    const locked = JSON.parse(await fs.readFile(path.join(root, 'evidence-lock.json'), 'utf8')) as {
      files: Record<string, string>;
    };
    expect(await protectedHashes(root)).toEqual(locked.files);
    expect(await independentTest(root)).toBe(1);

    const provider = new FakeProvider([
      tool({
        id: 'init',
        name: 'extension_init',
        arguments: { extensionId: 'pdf-reader', toolNames: ['read_pdf'] },
      }),
      tool({
        id: 'manifest',
        name: 'write_file',
        arguments: { path: '.echo/extension-staging/pdf-reader/extension.json', content: manifest },
      }),
      tool({
        id: 'entry',
        name: 'write_file',
        arguments: {
          path: '.echo/extension-staging/pdf-reader/index.mjs',
          content: extensionSource,
        },
      }),
      tool({
        id: 'self-test',
        name: 'write_file',
        arguments: {
          path: '.echo/extension-staging/pdf-reader/extension.test.mjs',
          content: selfTestSource,
        },
      }),
      tool({ id: 'check', name: 'extension_check', arguments: { extensionId: 'pdf-reader' } }),
      tool({ id: 'install', name: 'extension_install', arguments: { extensionId: 'pdf-reader' } }),
      tool({ id: 'read-pdf', name: 'read_pdf', arguments: { path: 'requirements.pdf' } }),
      tool({ id: 'baseline', name: 'run_command', arguments: { command: 'npm test' } }),
      tool({ id: 'inspect', name: 'read_file', arguments: { path: 'src/score-summary.mjs' } }),
      tool({
        id: 'fix',
        name: 'apply_patch',
        arguments: {
          path: 'src/score-summary.mjs',
          edits: [
            {
              oldText: 'average: scores.length === 0 ? 0 : total,',
              newText: 'average: scores.length === 0 ? 0 : total / scores.length,',
            },
          ],
        },
      }),
      tool({ id: 'verify', name: 'run_command', arguments: { command: 'npm test' } }),
      text('The synthetic PDF task is fixed and independently verifiable.'),
    ]);
    const first = await runGoal(
      await fs.readFile(path.join(root, 'prompt.txt'), 'utf8'),
      {
        workspace: root,
        safetyMode: 'full-access',
        allowFullAccess: true,
        maxSteps: 16,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot,
      },
      { env: { ECHO_API_KEY: 'fake-key' }, providerFactory: () => provider },
    );
    expect(first.exitCode).toBe(0);
    expect(provider.requests[6]?.tools.some((candidate) => candidate.name === 'read_pdf')).toBe(
      true,
    );
    expect(await protectedHashes(root)).toEqual(locked.files);
    expect(await independentTest(root)).toBe(0);

    const reuseProvider = new FakeProvider([
      tool({ id: 'reuse', name: 'read_pdf', arguments: { path: 'requirements.pdf' } }),
      text('The installed workspace PDF reader was reused in a new Session.'),
    ]);
    const second = await runGoal(
      'Use the installed read_pdf tool to summarize requirements.pdf.',
      {
        workspace: root,
        safetyMode: 'full-access',
        allowFullAccess: true,
        maxSteps: 4,
        verbose: false,
        color: false,
        interactive: false,
        artifactRoot,
      },
      { env: { ECHO_API_KEY: 'fake-key' }, providerFactory: () => reuseProvider },
    );
    expect(second.exitCode).toBe(0);
    expect(
      reuseProvider.requests[0]?.tools.some((candidate) => candidate.name === 'read_pdf'),
    ).toBe(true);
  }, 30_000);
});
