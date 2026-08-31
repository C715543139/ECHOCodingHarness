import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import type { ApprovalHandler } from '../agent/index.js';
import type { AgentResult, ModelProvider, RenderCapabilities } from '../contracts/index.js';

import {
  createInteractiveFullAccessConfirmer,
  resolveCliFullAccessConfirmation,
  type FullAccessConfirmer,
} from './full-access-confirmation.js';
import {
  APPROVAL_CHOICES,
  DefaultEventRenderer,
  formatApprovalQuestion,
} from './event-renderer.js';
import {
  createHarnessService,
  defaultIo,
  failConfiguration,
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
  readonly artifactRoot?: string;
  readonly fullAccessConfirmer?: FullAccessConfirmer;
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
  private readonly question: string;

  constructor(
    input: Readable = process.stdin,
    output: Writable = process.stderr,
    capabilities?: RenderCapabilities,
  ) {
    this.input = input;
    this.output = output;
    this.question =
      capabilities === undefined ? `${APPROVAL_CHOICES} > ` : formatApprovalQuestion(capabilities);
  }

  async requestApproval(request: Parameters<ApprovalHandler['requestApproval']>[0]) {
    const terminal = createInterface({ input: this.input, output: this.output, terminal: true });
    try {
      const answer = await terminal.question(this.question, {
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
  if (
    !options.interactive &&
    ((options.safetyMode === 'full-access' && options.allowFullAccess !== true) ||
      (options.allowFullAccess === true && options.safetyMode !== 'full-access'))
  ) {
    return failConfiguration(
      io,
      'configuration · Non-interactive Full Access requires both --safety-mode full-access and --allow-full-access.',
    );
  }
  const artifactRoot = options.artifactRoot ?? dependencies.artifactRoot;
  const loaded = await loadHarnessRuntime({
    options,
    env,
    cwd: dependencies.cwd ?? process.cwd(),
    io,
    artifactRoot,
    ...(dependencies.providerFactory === undefined
      ? {}
      : { providerFactory: dependencies.providerFactory }),
  });
  if ('exitCode' in loaded) {
    return loaded;
  }

  const authorization = await resolveCliFullAccessConfirmation({
    targetMode: loaded.config.safetyMode,
    explicitMode: options.safetyMode,
    interactive: options.interactive,
    allowFullAccess: options.allowFullAccess === true,
    ...(options.interactive
      ? {
          confirm:
            dependencies.fullAccessConfirmer ??
            createInteractiveFullAccessConfirmer(process.stdin, process.stderr, options.signal),
        }
      : {}),
  });
  if (!authorization.ok) {
    return failConfiguration(io, `configuration · ${authorization.message}`);
  }

  const renderer = new DefaultEventRenderer({
    workspaceRoot: loaded.workspaceRoot,
    secrets: [...loaded.secrets],
  });
  const service = await createHarnessService({
    runtime: loaded,
    unattendedApproval: options.interactive ? 'wait' : 'deny',
    ...(options.interactive
      ? {
          approvalHandler:
            dependencies.approvalHandler ??
            new InteractiveApprovalHandler(process.stdin, process.stderr, loaded.capabilities),
        }
      : {}),
    onEvent: (event) => writeChunks(renderer.renderEvent(event, loaded.capabilities), io),
  });
  try {
    const settings = newSessionSettings(options, loaded.config);
    const session = await service.createSession({
      workspaceRoot: loaded.workspaceRoot,
      provider: loaded.providerIdentity,
      model: settings.model,
      safetyMode: settings.safetyMode,
      ...(authorization.confirmation === undefined
        ? {}
        : { fullAccessConfirmation: authorization.confirmation }),
    });
    const result = await service.runTurn({
      sessionId: session.sessionId,
      goal,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    writeChunks(renderer.renderResult(result, loaded.capabilities), io);
    return { exitCode: toExitCode(result), result };
  } finally {
    await service.close();
  }
}
