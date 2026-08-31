import type { ExtensionManifest } from '../contracts/index.js';

export interface ExtensionAuthoringTemplate {
  readonly manifest: ExtensionManifest;
  readonly files: Readonly<Record<string, string>>;
}

function handlerSource(toolName: string): string {
  return `  ${JSON.stringify(toolName)}: async (_input, _context) => ({\n    status: 'failed',\n    summary: 'Implement ${toolName} before installation.',\n    error: {\n      category: 'tool_execution',\n      code: 'EXTENSION_NOT_IMPLEMENTED',\n      message: 'The generated extension handler is still a placeholder.',\n      retryable: false\n    },\n    truncated: false\n  })`;
}

function testSource(toolNames: readonly string[]): string {
  const names = JSON.stringify([...toolNames].sort());
  return `import assert from 'node:assert/strict';\nimport { handlers } from './index.mjs';\n\nassert.deepEqual(Object.keys(handlers).sort(), ${names});\nfor (const [name, handler] of Object.entries(handlers)) {\n  assert.equal(typeof handler, 'function', name + ' must be a function');\n}\nconsole.log('ECHO extension self-test passed');\n`;
}

function authoringGuide(extensionId: string, toolNames: readonly string[]): string {
  return `# ECHO workspace extension: ${extensionId}\n\nThis directory is staging content for the current workspace only. It is not installed or loaded yet.\n\n## Required workflow\n\n1. Keep extension.json on schemaVersion 1 and keep entry/selfTest extension-relative.\n2. Implement exactly these handlers: ${toolNames.map((name) => `\`${name}\``).join(', ')}.\n3. Each handler must return a structured ToolExecution object with status, summary, data/error, and truncated.\n4. Treat context.workspaceRoot as the only workspace boundary. Validate every path before access.\n5. Honor context.signal, context.limits.timeoutMs, and context.limits.maxOutputChars.\n6. Never read ECHO_API_KEY or unrelated host credentials. Never embed secrets in files or results.\n7. Extend extension.test.mjs with deterministic tests, including invalid input and failure cases.\n8. Run the self-test directly with Node, then call extension_check. Only install after all checks pass.\n\n## Runtime contract\n\n- index.mjs exports one plain object named handlers. Its keys must exactly match the Manifest tool names.\n- Handlers receive (input, context). The context contains workspaceRoot, callId, limits, and an AbortSignal.\n- Throwing becomes a bounded handler failure. Return expected user-facing failures as ToolExecution instead.\n- The Worker isolates crashes and cancellation but is not an OS sandbox. Full Access can still affect the machine.\n- Installation hashes every regular file. Links, path escapes, unknown Manifest fields, name collisions, and content races fail closed.\n- A crash, timeout that ignores cancellation, or protocol violation quarantines the whole extension.\n\n## Pre-install review\n\n- Confirm the tests exercise real behavior, not only exported names.\n- Confirm output is bounded and contains no credentials, absolute private paths, or hidden identity data.\n- Confirm file writes remain in the current workspace and destructive behavior is narrowly scoped.\n- Confirm dependencies are already available in the workspace; P3 does not install remote packages.\n`;
}

export function createExtensionAuthoringTemplate(
  extensionId: string,
  toolNames: readonly string[],
): ExtensionAuthoringTemplate {
  const manifest: ExtensionManifest = {
    schemaVersion: 1,
    id: extensionId,
    version: '0.1.0',
    entry: 'index.mjs',
    selfTest: 'extension.test.mjs',
    tools: toolNames.map((name) => ({
      name,
      description: `Execute the ${name} workspace extension capability.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    })),
  };
  return {
    manifest,
    files: {
      'extension.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'index.mjs': `export const handlers = {\n${toolNames.map(handlerSource).join(',\n')}\n};\n`,
      'extension.test.mjs': testSource(toolNames),
      'AUTHORING.md': authoringGuide(extensionId, toolNames),
    },
  };
}
