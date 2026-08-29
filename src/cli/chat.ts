import type { Readable, Writable } from 'node:stream';

import type { ApprovalHandler } from '../agent/index.js';
import type { EchoApplicationService } from '../application/index.js';
import {
  CONFIG_ERROR_CODES,
  type ModelCatalogClient,
  type ModelProvider,
  type SessionId,
  type SessionRuntimeState,
} from '../contracts/index.js';
import { ProcessModelCatalog } from '../provider/index.js';
import { configurationError, isConfigurationError } from '../session/index.js';

import {
  renderChatBanner,
  renderIdlePrompt,
  renderSessionStatus,
  renderSlashFeedback,
  renderYouPrompt,
  type SlashFeedbackInput,
  type StatusStripInput,
} from './chat-view.js';
import { StreamChatInput, type ChatInputPort } from './chat-input-reader.js';
import { DefaultEventRenderer } from './event-renderer.js';
import {
  createHarnessService,
  defaultIo,
  failConfiguration,
  loadHarnessRuntime,
  newSessionSettings,
  writeChunks,
  type CliIo,
  type HarnessCliOptions,
  type LoadedHarnessRuntime,
  type ProviderFactoryOptions,
} from './harness-runtime.js';
import {
  ConfigBackedChatCatalog,
  formatCatalogFeedback,
  isSelectableChatModel,
  type ChatModelCatalog,
  type ChatModelCatalogSnapshot,
} from './model-candidates.js';
import { CHAT_SLASH_HELP_LINES, parseIdleInput } from './parse-chat-input.js';
import { InteractiveApprovalHandler } from './run.js';
import { matchListedSessionId, sessionShortId } from './session-id.js';

export type { ChatModelCatalog } from './model-candidates.js';

export type ChatCommandOptions = HarnessCliOptions & {
  readonly resume?: string;
};

export interface ChatCommandDependencies {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly io?: CliIo;
  readonly providerFactory?: (options: ProviderFactoryOptions) => ModelProvider;
  readonly approvalHandler?: ApprovalHandler;
  readonly artifactRoot?: string;
  readonly input?: ChatInputPort;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly modelCatalog?: ChatModelCatalog;
  readonly attachInterrupt?: (handler: () => void) => () => void;
}

function streamIsTty(stream: Readable): boolean {
  return 'isTTY' in stream && (stream as { readonly isTTY?: boolean }).isTTY === true;
}

function statusStrip(runtime: SessionRuntimeState): StatusStripInput {
  const percent =
    runtime.approximateTokens !== undefined &&
    runtime.maxApproxTokens !== undefined &&
    runtime.maxApproxTokens > 0
      ? (runtime.approximateTokens / runtime.maxApproxTokens) * 100
      : undefined;
  return {
    workspaceName: runtime.workspaceName,
    model: runtime.model.value,
    safetyMode: runtime.safetyMode.value,
    ...(percent === undefined ? {} : { contextPercent: percent }),
  };
}

function defaultInterrupt(handler: () => void): () => void {
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

function asCatalogClient(provider: ModelProvider): ModelCatalogClient | undefined {
  if (
    !('listModelIds' in provider) ||
    typeof (provider as { listModelIds?: unknown }).listModelIds !== 'function'
  ) {
    return undefined;
  }
  return provider as ModelCatalogClient;
}

function createDefaultChatCatalog(
  loaded: LoadedHarnessRuntime,
  configuredModel: string,
): ChatModelCatalog {
  const client = asCatalogClient(loaded.provider);
  if (client === undefined) {
    return new ConfigBackedChatCatalog(loaded.config.modelCatalog, configuredModel);
  }
  const catalog = new ProcessModelCatalog({
    catalog: loaded.config.modelCatalog,
    configuredModel,
    cacheKey: loaded.providerIdentity.endpointFingerprint,
    client,
    timeoutMs: loaded.config.requestTimeoutMs,
  });
  return {
    listCandidates: (options) => catalog.listCandidates(options),
  };
}

export async function runChat(
  options: ChatCommandOptions,
  dependencies: ChatCommandDependencies = {},
): Promise<{ exitCode: number }> {
  const env = dependencies.env ?? process.env;
  const io = dependencies.io ?? defaultIo();
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

  const stdin = dependencies.stdin ?? process.stdin;
  const stderr = dependencies.stderr ?? process.stderr;
  const input =
    dependencies.input ??
    new StreamChatInput({
      input: stdin,
      output: stderr,
      bracketedPaste: options.interactive && streamIsTty(stdin),
    });
  const approvalHandler =
    dependencies.approvalHandler ??
    (options.interactive
      ? new InteractiveApprovalHandler(stdin, stderr, loaded.capabilities)
      : undefined);

  let turnRunning = false;
  const service = createHarnessService({
    runtime: loaded,
    unattendedApproval: options.interactive ? 'wait' : 'deny',
    ...(approvalHandler === undefined ? {} : { approvalHandler }),
    onEvent: (event) => {
      const renderer = turnRenderer;
      if (renderer === undefined) return;
      writeChunks(renderer.renderEvent(event, loaded.capabilities), io);
    },
  });

  let turnRenderer: DefaultEventRenderer | undefined;
  let runtime: SessionRuntimeState;
  let idleInterrupt = false;
  let catalogAbort: AbortController | undefined;
  try {
    runtime = await openSession(service, loaded, options);
  } catch (error) {
    input.close();
    if (isConfigurationError(error)) {
      return failConfiguration(io, `configuration · ${error.message}`);
    }
    throw error;
  }
  const sessionId = runtime.sessionId;
  const catalog =
    dependencies.modelCatalog ?? createDefaultChatCatalog(loaded, runtime.model.value);

  writeChunks(
    renderChatBanner(
      {
        workspaceName: runtime.workspaceName,
        sessionShortId: sessionShortId(runtime.sessionId),
        providerLabel: 'OpenAI-compatible',
        model: runtime.model.value,
        safetyMode: runtime.safetyMode.value,
        resumed: options.resume !== undefined,
      },
      loaded.capabilities,
    ),
    io,
  );

  const interrupt = (): void => {
    catalogAbort?.abort();
    if (turnRunning) {
      void service.cancelTurn(sessionId);
      return;
    }
    idleInterrupt = true;
    input.close();
  };
  const detachInterrupt = (dependencies.attachInterrupt ?? defaultInterrupt)(interrupt);
  input.start?.();

  let exitCode = 0;
  let printStrip = true;
  try {
    while (!idleInterrupt) {
      if (printStrip) {
        writeChunks(renderIdlePrompt(statusStrip(runtime), loaded.capabilities), io);
      } else {
        writeChunks([renderYouPrompt(loaded.capabilities)], io);
      }
      printStrip = true;

      const next = await input.read();
      if (idleInterrupt || next.kind === 'interrupt') {
        exitCode = 130;
        break;
      }
      if (next.kind === 'eof') {
        break;
      }

      const parsed = parseIdleInput(next.text, next.source);
      if (parsed.kind === 'empty') {
        printStrip = false;
        continue;
      }
      if (parsed.kind === 'error') {
        writeChunks(
          renderSlashFeedback(
            { kind: 'error', label: 'COMMAND', message: parsed.message },
            loaded.capabilities,
          ),
          io,
        );
        continue;
      }
      if (parsed.kind === 'slash') {
        catalogAbort = new AbortController();
        const outcome = await handleSlash({
          parsed,
          service,
          runtime,
          loaded,
          io,
          catalog,
          signal: catalogAbort.signal,
        });
        catalogAbort = undefined;
        runtime = outcome.runtime;
        if (idleInterrupt) {
          exitCode = 130;
          break;
        }
        if (outcome.quit) {
          exitCode = 0;
          break;
        }
        continue;
      }

      input.pause?.();
      turnRunning = true;
      turnRenderer = new DefaultEventRenderer(
        {
          workspaceRoot: loaded.workspaceRoot,
          secrets: [...loaded.secrets],
        },
        'chat',
      );
      try {
        const result = await service.runTurn({
          sessionId: runtime.sessionId,
          goal: parsed.text,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        writeChunks(turnRenderer.renderResult(result, loaded.capabilities), io);
      } finally {
        turnRunning = false;
        turnRenderer = undefined;
        input.resume?.();
      }
      runtime = await service.getRuntimeState(runtime.sessionId);
    }
  } finally {
    detachInterrupt();
    input.close();
  }

  return { exitCode: idleInterrupt ? 130 : exitCode };
}

async function resolveResumeSessionId(
  service: EchoApplicationService,
  workspaceRoot: string,
  requested: string,
): Promise<SessionId> {
  const listed = await service.listSessions(workspaceRoot);
  const match = matchListedSessionId(
    requested,
    listed.map((session) => session.sessionId),
  );
  if (match.kind === 'ambiguous') {
    throw configurationError(
      CONFIG_ERROR_CODES.sessionNotFound,
      'Multiple sessions match that SESSION identifier. Use the full session ID.',
    );
  }
  if (match.kind === 'resolved') return match.sessionId;
  return requested;
}

async function openSession(
  service: EchoApplicationService,
  loaded: LoadedHarnessRuntime,
  options: ChatCommandOptions,
): Promise<SessionRuntimeState> {
  if (options.resume !== undefined) {
    const sessionId = await resolveResumeSessionId(service, loaded.workspaceRoot, options.resume);
    return service.resumeSession({
      workspaceRoot: loaded.workspaceRoot,
      sessionId,
      provider: loaded.providerIdentity,
      ...(options.model === undefined ? {} : { cliModel: options.model }),
      ...(options.safetyMode === undefined ? {} : { cliSafetyMode: options.safetyMode }),
    });
  }
  const settings = newSessionSettings(options, loaded.config);
  return service.createSession({
    workspaceRoot: loaded.workspaceRoot,
    provider: loaded.providerIdentity,
    model: settings.model,
    safetyMode: settings.safetyMode,
  });
}

async function handleSlash(input: {
  readonly parsed: Extract<ReturnType<typeof parseIdleInput>, { kind: 'slash' }>;
  readonly service: EchoApplicationService;
  readonly runtime: SessionRuntimeState;
  readonly loaded: LoadedHarnessRuntime;
  readonly io: CliIo;
  readonly catalog: ChatModelCatalog;
  readonly signal: AbortSignal;
}): Promise<{ runtime: SessionRuntimeState; quit: boolean }> {
  const { parsed, service, loaded, io } = input;
  let runtime = input.runtime;

  if (parsed.name === 'quit') {
    return { runtime, quit: true };
  }
  if (parsed.name === 'help') {
    feedback(io, { kind: 'help', lines: CHAT_SLASH_HELP_LINES }, loaded);
    return { runtime, quit: false };
  }
  if (parsed.name === 'status') {
    writeChunks(
      renderSessionStatus(
        {
          workspaceName: runtime.workspaceName,
          sessionShortId: sessionShortId(runtime.sessionId),
          providerLabel: 'OpenAI-compatible',
          model: runtime.model.value,
          modelSource: runtime.model.source,
          safetyMode: runtime.safetyMode.value,
          safetySource: runtime.safetyMode.source,
          turns: runtime.turnCount,
          contextUsed: runtime.approximateTokens ?? 0,
          contextBudget: runtime.maxApproxTokens ?? loaded.config.context.maxApproxTokens,
          ...(runtime.lastTurn === undefined
            ? {}
            : {
                lastTurn: {
                  status: `${runtime.lastTurn.status} (${runtime.lastTurn.stopReason})`,
                  steps: runtime.lastTurn.steps,
                  tools: runtime.lastTurn.toolCalls,
                },
              }),
          apiKey: loaded.config.apiKeyPresent ? 'configured' : 'missing',
        },
        loaded.capabilities,
      ),
      io,
    );
    return { runtime, quit: false };
  }
  if (parsed.name === 'safety') {
    if (parsed.argument === undefined) {
      feedback(io, { kind: 'info', label: 'SAFETY', lines: [runtime.safetyMode.value] }, loaded);
      return { runtime, quit: false };
    }
    runtime = await service.setSessionSafetyMode(runtime.sessionId, parsed.argument, 'slash');
    feedback(io, { kind: 'safety', value: runtime.safetyMode.value }, loaded);
    return { runtime, quit: false };
  }

  const modelArgument = parsed.name === 'model' ? parsed.argument : undefined;
  const refresh = modelArgument === 'refresh';
  let snapshot: ChatModelCatalogSnapshot;
  try {
    snapshot = await input.catalog.listCandidates({
      refresh,
      signal: input.signal,
      configuredModel: runtime.model.value,
    });
  } catch (error) {
    if (input.signal.aborted) {
      return { runtime, quit: false };
    }
    snapshot = {
      status: 'failed' as const,
      source: loaded.config.modelCatalog.source,
      models: [runtime.model.value],
      cached: false,
      refreshed: refresh,
      configuredModel: runtime.model.value,
      error: {
        message: error instanceof Error ? error.message : 'The model catalog request failed.',
      },
    };
  }
  if (input.signal.aborted) {
    return { runtime, quit: false };
  }
  if (modelArgument === undefined || refresh) {
    feedback(io, { kind: 'info', label: 'MODEL', lines: formatCatalogFeedback(snapshot) }, loaded);
    return { runtime, quit: false };
  }

  if (!isSelectableChatModel(modelArgument, snapshot)) {
    feedback(
      io,
      {
        kind: 'error',
        label: 'MODEL',
        message: `Unknown or unavailable model: ${modelArgument}`,
      },
      loaded,
    );
    return { runtime, quit: false };
  }

  runtime = await service.setSessionModel(runtime.sessionId, modelArgument, 'slash');
  feedback(io, { kind: 'model', value: runtime.model.value }, loaded);
  return { runtime, quit: false };
}

function feedback(io: CliIo, payload: SlashFeedbackInput, loaded: LoadedHarnessRuntime): void {
  writeChunks(renderSlashFeedback(payload, loaded.capabilities), io);
}
