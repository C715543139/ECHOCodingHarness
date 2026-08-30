import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertAggregatedSessionJsonl } from './session-text-invariants.mjs';

const enabled = process.env.ECHO_RUN_PROVIDER_SMOKE === '1';

if (!enabled) {
  process.stdout.write(
    'Provider smoke check skipped. Set ECHO_RUN_PROVIDER_SMOKE=1 to enable a real request.\n',
  );
  process.exit(0);
}

const required = ['ECHO_BASE_URL', 'ECHO_API_KEY', 'ECHO_MODEL'];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`Provider smoke check is enabled but missing: ${missing.join(', ')}`);
}

const {
  AgentLoop,
  CentralSafetyPolicy,
  EventContextBuilder,
  JsonlSessionStore,
  OpenAICompatibleProvider,
  ToolRegistry,
  createOpenAIClient,
} = await import('../dist/index.js');

const timeoutMs = 60_000;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);
const apiKey = process.env.ECHO_API_KEY;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-provider-smoke-'));

try {
  const provider = new OpenAICompatibleProvider({
    client: createOpenAIClient({
      baseUrl: process.env.ECHO_BASE_URL,
      apiKey,
      timeoutMs,
    }),
    model: process.env.ECHO_MODEL,
    requestTimeoutMs: timeoutMs,
    retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
  });
  const store = new JsonlSessionStore({
    workspaceRoot: workspace,
    secrets: [apiKey],
    homeDirectory: os.homedir(),
  });
  const loop = new AgentLoop({
    provider,
    model: process.env.ECHO_MODEL,
    tools: new ToolRegistry([]),
    policy: new CentralSafetyPolicy(),
    contextBuilder: new EventContextBuilder({
      systemPrompt: 'Reply briefly. Do not call tools or print secrets.',
    }),
    sessionStore: store,
    workspaceRoot: workspace,
    safetyMode: 'balanced',
    maxSteps: 1,
    contextBudget: { maxApproxTokens: 4_000, reservedOutputTokens: 1_024 },
    toolLimits: { timeoutMs: 1_000, maxOutputChars: 1_000 },
    secrets: [apiKey],
    homeDirectory: os.homedir(),
  });

  const result = await loop.run(
    'Reply with exactly ECHO_PROVIDER_SMOKE_OK and do not call tools.',
    controller.signal,
  );
  const jsonlPath = path.join(workspace, '.echo', 'sessions', `${result.sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) {
    throw new Error('Provider smoke check did not persist a Session JSONL log.');
  }
  const summary = assertAggregatedSessionJsonl(fs.readFileSync(jsonlPath, 'utf8'));
  if (summary.textEvents === 0) {
    throw new Error('Provider smoke check persisted no aggregated model.text.');
  }

  process.stdout.write('Provider smoke check passed.\n');
} finally {
  clearTimeout(timeout);
  fs.rmSync(workspace, { recursive: true, force: true });
}
