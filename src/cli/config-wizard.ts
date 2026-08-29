import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import { CLI_EXIT_CODES } from '../contracts/exit-codes.js';
import type { EchoPersistentConfig, ModelCatalogConfig } from '../contracts/config.js';
import type { SafetyMode } from '../contracts/safety.js';

import {
  inspectProviderUrl,
  parsePersistentConfig,
  persistentConfigPath,
  readPersistentConfigFile,
  SAFETY_MODES,
  writePersistentConfigFile,
} from '../config/index.js';

export interface ConfigWizardIo {
  write(text: string): void;
  prompt(message: string): Promise<string>;
}

export interface RunConfigWizardOptions {
  readonly artifactRoot: string;
  readonly io: ConfigWizardIo;
  readonly signal?: AbortSignal;
}

export interface ConfigWizardOutcome {
  readonly exitCode: number;
  readonly configPath?: string;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (error as NodeJS.ErrnoException).code === 'ABORT_ERR'
  );
}

async function ask(io: ConfigWizardIo, message: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }
  return io.prompt(message);
}

function formatCatalog(catalog: ModelCatalogConfig): string {
  if (catalog.source === 'discover') {
    return 'discover';
  }
  return `manual [${catalog.models.join(', ')}]`;
}

async function promptUrl(
  io: ConfigWizardIo,
  draft: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  for (;;) {
    const hint = draft === undefined ? '' : ` [${draft}]`;
    const answer = (await ask(io, `Provider URL${hint}: `, signal)).trim();
    const candidate = answer.length === 0 ? draft : answer;
    const inspected = inspectProviderUrl(candidate);
    if ('href' in inspected) {
      return inspected.href;
    }
    io.write(`${inspected.message}\n`);
  }
}

async function promptCatalogSource(
  io: ConfigWizardIo,
  draft: ModelCatalogConfig['source'] | undefined,
  signal?: AbortSignal,
): Promise<'discover' | 'manual'> {
  const hint = draft === undefined ? 'discover' : draft;
  for (;;) {
    io.write('Model catalog: [1] discover  [2] manual\n');
    const answer = (await ask(io, `Choice [${hint}]: `, signal)).trim().toLowerCase();
    if (answer.length === 0) {
      return hint;
    }
    if (answer === '1' || answer === 'discover' || answer === 'd') {
      return 'discover';
    }
    if (answer === '2' || answer === 'manual' || answer === 'm') {
      return 'manual';
    }
    io.write('Enter 1/discover or 2/manual.\n');
  }
}

async function promptManualModels(
  io: ConfigWizardIo,
  draft: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  io.write('Enter unique model IDs, one per line. An empty line finishes.\n');
  if (draft !== undefined && draft.length > 0) {
    io.write(`Current list: ${draft.join(', ')}\n`);
  }
  const models: string[] = [];
  const seen = new Set<string>();
  for (;;) {
    const answer = (await ask(io, 'Model ID: ', signal)).trim();
    if (answer.length === 0) {
      if (models.length > 0) {
        return models;
      }
      if (draft !== undefined && draft.length > 0) {
        return [...draft];
      }
      io.write('Manual catalog needs at least one model ID.\n');
      continue;
    }
    if (seen.has(answer)) {
      io.write(`Duplicate model ID "${answer}" ignored.\n`);
      continue;
    }
    seen.add(answer);
    models.push(answer);
  }
}

async function promptDefaultModel(
  io: ConfigWizardIo,
  catalog: ModelCatalogConfig,
  draft: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  for (;;) {
    const hint =
      draft !== undefined ? draft : catalog.source === 'manual' ? catalog.models[0] : undefined;
    const suffix = hint === undefined ? '' : ` [${hint}]`;
    const answer = (await ask(io, `Default model${suffix}: `, signal)).trim();
    const model = answer.length === 0 ? hint : answer;
    if (model === undefined || model.length === 0) {
      io.write('Default model is required.\n');
      continue;
    }
    if (catalog.source === 'manual' && !catalog.models.includes(model)) {
      io.write(`Default model must be one of: ${catalog.models.join(', ')}.\n`);
      continue;
    }
    return model;
  }
}

async function promptSafetyMode(
  io: ConfigWizardIo,
  draft: SafetyMode | undefined,
  signal?: AbortSignal,
): Promise<SafetyMode> {
  const hint = draft ?? 'balanced';
  for (;;) {
    const answer = (await ask(io, `Safety mode (${SAFETY_MODES.join(' / ')}) [${hint}]: `, signal))
      .trim()
      .toLowerCase();
    const candidate = answer.length === 0 ? hint : answer;
    if ((SAFETY_MODES as readonly string[]).includes(candidate)) {
      return candidate as SafetyMode;
    }
    io.write(`Safety mode must be one of: ${SAFETY_MODES.join(', ')}.\n`);
  }
}

async function promptConfirm(io: ConfigWizardIo, signal?: AbortSignal): Promise<boolean> {
  for (;;) {
    const answer = (await ask(io, 'Write this configuration? [y]es / [n]o: ', signal))
      .trim()
      .toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      return true;
    }
    if (answer === 'n' || answer === 'no') {
      return false;
    }
    io.write('Enter y or n.\n');
  }
}

async function readExistingDraft(artifactRoot: string): Promise<EchoPersistentConfig | undefined> {
  const file = await readPersistentConfigFile(artifactRoot);
  if (file.status !== 'loaded') {
    return undefined;
  }
  const parsed = parsePersistentConfig(file.raw);
  if ('issues' in parsed) {
    return undefined;
  }
  return parsed.config;
}

export async function runConfigWizard(
  options: RunConfigWizardOptions,
): Promise<ConfigWizardOutcome> {
  const { artifactRoot, io, signal } = options;
  const destPath = persistentConfigPath(artifactRoot);
  io.write('ECHO Harness · config\n\n');
  io.write(`This writes ${destPath}\n`);
  io.write('API keys stay in ECHO_API_KEY and are never saved.\n\n');

  try {
    const existing = await readExistingDraft(artifactRoot);
    const baseUrl = await promptUrl(io, existing?.baseUrl, signal);
    const source = await promptCatalogSource(io, existing?.modelCatalog.source, signal);
    const catalog: ModelCatalogConfig =
      source === 'discover'
        ? { source: 'discover' }
        : {
            source: 'manual',
            models: await promptManualModels(
              io,
              existing?.modelCatalog.source === 'manual' ? existing.modelCatalog.models : undefined,
              signal,
            ),
          };
    if (source === 'discover') {
      io.write(
        'Discover stores only the default model. Candidate IDs are fetched later with GET /models and cached in-process.\n',
      );
    }
    const model = await promptDefaultModel(io, catalog, existing?.model, signal);
    const safetyMode = await promptSafetyMode(io, existing?.safetyMode, signal);
    const draft: EchoPersistentConfig = { baseUrl, model, modelCatalog: catalog, safetyMode };

    io.write('\n');
    io.write(`baseUrl      ${draft.baseUrl}\n`);
    io.write(`model        ${draft.model}\n`);
    io.write(`modelCatalog ${formatCatalog(draft.modelCatalog)}\n`);
    io.write(`safetyMode   ${draft.safetyMode ?? 'balanced'}\n\n`);

    const confirmed = await promptConfirm(io, signal);
    if (!confirmed) {
      io.write('Cancelled. Existing configuration was not changed.\n');
      return { exitCode: CLI_EXIT_CODES.success };
    }

    const written = await writePersistentConfigFile(artifactRoot, draft);
    io.write(`Wrote ${written.path}\n`);
    return { exitCode: CLI_EXIT_CODES.success, configPath: written.path };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      io.write('\nCancelled. No configuration file was written.\n');
      return { exitCode: CLI_EXIT_CODES.cancelled };
    }
    throw error;
  }
}

export async function runConfigCommand(options: {
  readonly artifactRoot: string;
  readonly interactive: boolean;
  readonly signal?: AbortSignal;
  readonly io?: ConfigWizardIo;
}): Promise<ConfigWizardOutcome> {
  if (!options.interactive && options.io === undefined) {
    process.stderr.write(
      'FAIL   configuration · echo-harness config requires an interactive terminal.\n',
    );
    return { exitCode: CLI_EXIT_CODES.usageOrConfig };
  }

  if (options.io !== undefined) {
    return runConfigWizard({
      artifactRoot: options.artifactRoot,
      io: options.io,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  const session = createReadlineWizardIo(process.stdin, process.stderr, options.signal);
  try {
    return await runConfigWizard({
      artifactRoot: options.artifactRoot,
      io: session.io,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    session.close();
  }
}

export function createReadlineWizardIo(
  input: Readable = process.stdin,
  output: Writable = process.stderr,
  signal?: AbortSignal,
): { io: ConfigWizardIo; close: () => void } {
  const terminal = createInterface({ input, output, terminal: true });
  return {
    io: {
      write: (text) => {
        output.write(text);
      },
      prompt: async (message) =>
        signal === undefined ? terminal.question(message) : terminal.question(message, { signal }),
    },
    close: () => terminal.close(),
  };
}
