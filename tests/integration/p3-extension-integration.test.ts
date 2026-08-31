import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EchoApplicationService } from '../../src/application/index.js';
import type { ExtensionManifest, FullAccessConfirmation } from '../../src/contracts/index.js';
import { EventContextBuilder } from '../../src/context/index.js';
import { WorkspaceExtensionSystem } from '../../src/extensions/index.js';
import { FakeProvider } from '../../src/provider/index.js';
import { CentralSafetyPolicy } from '../../src/security/index.js';
import { createProviderIdentity, JsonlSessionRepository } from '../../src/session/index.js';
import { DEFAULT_TOOLS, ToolRegistry } from '../../src/tools/index.js';

const temporaryDirectories: string[] = [];
const identity = createProviderIdentity('https://provider.example/v1');
const confirmation: FullAccessConfirmation = {
  acceptedRisk: true,
  source: 'cli-interactive',
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-p3-integration-'));
  temporaryDirectories.push(root);
  return root;
}

async function stagePdfReader(system: WorkspaceExtensionSystem): Promise<void> {
  const manifest: ExtensionManifest = {
    schemaVersion: 1,
    id: 'pdf-reader',
    version: '1.0.0',
    entry: 'index.mjs',
    selfTest: 'extension.test.mjs',
    tools: [
      {
        name: 'read_pdf',
        description: 'Read a synthetic PDF.',
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ],
  };
  const root = await system.lifecycle.store.stagingExtensionPath(manifest.id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'extension.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(
    path.join(root, manifest.entry),
    `export const handlers = { read_pdf: async () => ({ status: 'completed', summary: 'PDF read', data: { requirement: 'return forty-two' }, truncated: false }) };\n`,
  );
  await fs.writeFile(path.join(root, manifest.selfTest), `console.log('ok');\n`);
}

describe('P3 production extension integration', () => {
  it('installs for the next model request and reuses the tool in a new Session', async () => {
    const root = await workspace();
    const provider = new FakeProvider([
      {
        events: [
          {
            type: 'tool_call',
            call: {
              id: 'call-install',
              name: 'extension_install',
              arguments: { extensionId: 'pdf-reader' },
            },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          {
            type: 'tool_call',
            call: { id: 'call-read', name: 'read_pdf', arguments: {} },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'Installed and read.' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      {
        events: [
          {
            type: 'tool_call',
            call: { id: 'call-reuse', name: 'read_pdf', arguments: {} },
          },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'Reused.' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
      {
        events: [
          { type: 'text_delta', delta: 'Safe mode.' },
          { type: 'completed', finishReason: 'stop' },
        ],
      },
    ]);
    const registry = new ToolRegistry(DEFAULT_TOOLS);
    const extensions = await WorkspaceExtensionSystem.open({ workspaceRoot: root, registry });
    await stagePdfReader(extensions);
    const service = new EchoApplicationService({
      repository: new JsonlSessionRepository({ workspaceRoot: root }),
      provider,
      providerIdentity: identity,
      tools: registry,
      policy: new CentralSafetyPolicy(),
      contextBuilder: new EventContextBuilder({ systemPrompt: 'Test system.' }),
      workspaceRoot: root,
      maxSteps: 6,
      contextBudget: { maxApproxTokens: 8_000, reservedOutputTokens: 500 },
      toolLimits: { timeoutMs: 2_000, maxOutputChars: 8_000 },
      prepareToolsForTurn: (runtime, signal) =>
        extensions.prepareForTurn(runtime.safetyMode.value, signal),
      closeTools: () => extensions.close(),
    });

    const createSession = () =>
      service.createSession({
        workspaceRoot: root,
        provider: identity,
        model: { value: 'fake-model', source: 'config' },
        safetyMode: { value: 'full-access', source: 'config' },
        fullAccessConfirmation: confirmation,
      });
    const first = await createSession();
    await expect(
      service.runTurn({ sessionId: first.sessionId, goal: 'install and read' }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(provider.requests[0]?.tools.some((tool) => tool.name === 'extension_install')).toBe(
      true,
    );
    expect(provider.requests[0]?.tools.some((tool) => tool.name === 'read_pdf')).toBe(false);
    expect(provider.requests[1]?.tools.some((tool) => tool.name === 'read_pdf')).toBe(true);

    const second = await createSession();
    await expect(
      service.runTurn({ sessionId: second.sessionId, goal: 'reuse reader' }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(provider.requests[3]?.tools.some((tool) => tool.name === 'read_pdf')).toBe(true);

    await service.setSessionSafetyMode(second.sessionId, 'balanced');
    await expect(
      service.runTurn({ sessionId: second.sessionId, goal: 'continue safely' }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(provider.requests[5]?.tools.some((tool) => tool.name === 'read_pdf')).toBe(false);
    expect(provider.requests[5]?.tools.some((tool) => tool.name === 'extension_install')).toBe(
      false,
    );
    expect(await extensions.lifecycle.list()).toMatchObject([
      { id: 'pdf-reader', state: 'enabled', loaded: false },
    ]);
    await service.close();
  });
});
