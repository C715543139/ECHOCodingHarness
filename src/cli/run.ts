import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import type { ApprovalHandler } from '../agent/index.js';
import type { AgentResult, ModelProvider } from '../contracts/index.js';

import { DefaultEventRenderer } from './event-renderer.js';
import {
  createHarnessService,
  defaultIo,
  loadHarnessRuntime,
  newSessionSettings,
  writeChunks,
  type CliIo,
  type HarnessCliOptions,
  type ProviderFactoryOptions,
} from './harness-runtime.js';

export type { CliIo, ProviderFactoryOptions };

export type RunGoalOptions = HarnessCliOptions;

export interface RunGoalDependencies {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly io?: CliIo;
  readonly providerFactory?: (options: ProviderFactoryOptions) => ModelProvider;
  readonly approvalHandler?: ApprovalHandler;
}

export interface RunGoalOutcome {
  readonly exitCode: number;
  readonly result?: AgentResult;
}

export function toExitCode(result: AgentResult): number {
  if (result.status === 'completed') return 0;
  if (result.status === 'cancelled' || result.stopReason === 'cancelled') return 130;
  if (result.status === 'limited') return 6;
  if (result.stopReason === 'provider_error') return 3;
  if (result.stopReason === 'tool_error') return 4;
  if (result.stopReason === 'policy_denied') return 5;
  return 1;
}

export class InteractiveApprovalHandler implements ApprovalHandler {
  private readonly input: Readable;
  private readonly output: Writable;

  constructor(input: Readable = process.stdin, output: Writable = process.stderr) {
    this.input = input;
    this.output = output;
  }

  async requestApproval(request: Parameters<ApprovalHandler['requestApproval']>[0]) {
    const terminal = createInterface({ input: this.input, output: this.output, terminal: true });
    try {
      const answer = await terminal.question('', {
        signal: request.signal,
      });
      const normalized = answer.trim().toLocaleLowerCase('en-US');
      if (normalized === 'y' || normalized === 'yes' || normalized === 'once')
        return 'once' as const;
      if (normalized === 's' || normalized === 'session') return 'session' as const;
      return 'deny' as const;
    } finally {
      terminal.close();
    }
  }
}

export async function runGoal(
  goal: string,
  options: RunGoalOptions,
  dependencies: RunGoalDependencies = {},
): Promise<RunGoalOutcome> {
  const env = dependencies.env ?? process.env;
  const io = dependencies.io ?? defaultIo();
  const loaded = await loadHarnessRuntime({
    options,
    env,
    cwd: dependencies.cwd ?? process.cwd(),
    io,
    ...(dependencies.providerFactory === undefined
      ? {}
      : { providerFactory: dependencies.providerFactory }),
  });
  if ('exitCode' in loaded) {
    return loaded;
  }

  const renderer = new DefaultEventRenderer({
    workspaceRoot: loaded.workspaceRoot,
    secrets: [...loaded.secrets],
  });
  const service = createHarnessService({
    runtime: loaded,
    unattendedApproval: options.interactive ? 'wait' : 'deny',
    ...(options.interactive
      ? { approvalHandler: dependencies.approvalHandler ?? new InteractiveApprovalHandler() }
      : {}),
    onEvent: (event) => writeChunks(renderer.renderEvent(event, loaded.capabilities), io),
  });
  const settings = newSessionSettings(options, loaded.config);
  const session = await service.createSession({
    workspaceRoot: loaded.workspaceRoot,
    provider: loaded.providerIdentity,
    model: settings.model,
    safetyMode: settings.safetyMode,
  });
  const result = await service.runTurn({
    sessionId: session.sessionId,
    goal,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  writeChunks(renderer.renderResult(result, loaded.capabilities), io);
  return { exitCode: toExitCode(result), result };
}
