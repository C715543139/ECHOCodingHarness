import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentLoop } from '../../src/agent/index.js';
import { EventContextBuilder } from '../../src/context/index.js';
import type {
  AgentResult,
  AgentStatus,
  AgentStopReason,
  EchoEvent,
  ModelToolCall,
} from '../../src/contracts/index.js';
import type { FakeProviderResponse } from '../../src/provider/index.js';
import { FakeProvider } from '../../src/provider/index.js';
import { CentralSafetyPolicy } from '../../src/security/index.js';
import { JsonlSessionStore } from '../../src/session/index.js';
import { DEFAULT_TOOLS, ToolRegistry } from '../../src/tools/index.js';

export interface EvalRecord {
  readonly name: string;
  readonly status: AgentStatus;
  readonly steps: number;
  readonly toolCalls: number;
  readonly stopReason: AgentStopReason;
  readonly finalText?: string;
}

export interface EvalRun {
  readonly record: EvalRecord;
  readonly result: AgentResult;
  readonly events: EchoEvent[];
  readonly workspaceRoot: string;
  readonly provider: FakeProvider;
  readonly summary: string;
}

export interface EvalLoopOptions {
  readonly name: string;
  readonly responses: readonly FakeProviderResponse[];
  readonly workspaceRoot: string;
  readonly goal?: string;
  readonly safetyMode?: 'safe' | 'balanced' | 'auto';
  readonly maxSteps?: number;
  readonly repeatedToolCallLimit?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const SIX_TOOLS = [
  'list_files',
  'search_text',
  'read_file',
  'write_file',
  'apply_patch',
  'run_command',
] as const;

export function toolTurn(call: ModelToolCall): FakeProviderResponse {
  return {
    events: [
      { type: 'tool_call', call },
      { type: 'completed', finishReason: 'tool_calls' },
    ],
  };
}

export function textTurn(text: string): FakeProviderResponse {
  return {
    events: [
      { type: 'text_delta', delta: text },
      { type: 'completed', finishReason: 'stop' },
    ],
  };
}

export function formatEvalSummary(record: EvalRecord): string {
  return [
    `EVAL ${record.name}`,
    `status     ${record.status}`,
    `steps      ${String(record.steps)}`,
    `toolCalls  ${String(record.toolCalls)}`,
    `stopReason ${record.stopReason}`,
  ].join('\n');
}

export function toEvalRecord(name: string, result: AgentResult): EvalRecord {
  return {
    name,
    status: result.status,
    steps: result.steps,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason,
    ...(result.finalText === undefined ? {} : { finalText: result.finalText }),
  };
}

export async function createEvalWorkspace(label = 'echo-eval-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), label));
}

export async function removeEvalWorkspace(workspaceRoot: string): Promise<void> {
  await rm(workspaceRoot, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
}

export async function runOfflineEval(options: EvalLoopOptions): Promise<EvalRun> {
  const provider = new FakeProvider(options.responses);
  const store = new JsonlSessionStore({ workspaceRoot: options.workspaceRoot });
  const counters: Record<'session' | 'turn' | 'step' | 'event', number> = {
    session: 0,
    turn: 0,
    step: 0,
    event: 0,
  };
  const loop = new AgentLoop({
    provider,
    model: 'fake-eval-model',
    tools: new ToolRegistry(DEFAULT_TOOLS),
    policy: new CentralSafetyPolicy(),
    contextBuilder: new EventContextBuilder({
      systemPrompt: 'Stay inside the workspace. Never print secrets or absolute personal paths.',
    }),
    sessionStore: store,
    workspaceRoot: options.workspaceRoot,
    safetyMode: options.safetyMode ?? 'balanced',
    maxSteps: options.maxSteps ?? 12,
    repeatedToolCallLimit: options.repeatedToolCallLimit ?? 3,
    contextBudget: { maxApproxTokens: 8_000, reservedOutputTokens: 1_000 },
    toolLimits: { timeoutMs: options.timeoutMs ?? 8_000, maxOutputChars: 8_000 },
    idFactory: (kind) => `${kind}-${String(++counters[kind])}`,
    now: () => '2026-08-28T00:00:00.000Z',
  });

  const result = await loop.run(options.goal ?? options.name, options.signal);
  const events: EchoEvent[] = [];
  for await (const event of store.read(result.sessionId)) {
    events.push(event);
  }

  const record = toEvalRecord(options.name, result);
  return {
    record,
    result,
    events,
    workspaceRoot: options.workspaceRoot,
    provider,
    summary: formatEvalSummary(record),
  };
}

export function eventTypes(events: readonly EchoEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

export function completedToolNames(events: readonly EchoEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => event.payload.result.toolName);
}

export function requestedToolNames(events: readonly EchoEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === 'tool.requested')
    .map((event) => event.payload.call.name);
}

export function terminalToolEvents(events: readonly EchoEvent[]): readonly EchoEvent[] {
  return events.filter(
    (event) =>
      event.type === 'tool.completed' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.denied' ||
      event.type === 'tool.cancelled',
  );
}

export function jsonlHasContextProjection(events: readonly EchoEvent[]): boolean {
  return events.some((event) => event.type === 'context.projected');
}

export const DEFAULT_EVAL_TOOLS: readonly string[] = SIX_TOOLS;
