import { Command, InvalidArgumentError, Option } from 'commander';

import { isAbsoluteArtifactRoot, resolveArtifactRootFromEntry } from '../config/index.js';
import type { SafetyMode } from '../contracts/index.js';
import { PROJECT_NAME, PROJECT_TAGLINE, PROJECT_VERSION } from '../core/project.js';

import { runChat, type ChatCommandOptions } from './chat.js';
import { runConfigCommand } from './config-wizard.js';
import { runGoal, type RunGoalOptions, type RunGoalOutcome } from './run.js';
import { runWeb, type WebCommandOptions } from './web.js';

export interface CreateCliOptions {
  readonly version?: string;
  readonly artifactRoot?: string;
  readonly entryUrl?: string;
  readonly runAction?: (goal: string, options: RunGoalOptions) => Promise<RunGoalOutcome>;
  readonly chatAction?: (options: ChatCommandOptions) => Promise<{ exitCode: number }>;
  readonly configAction?: (options: {
    artifactRoot: string;
    interactive: boolean;
    signal: AbortSignal;
  }) => Promise<{ exitCode: number }>;
  readonly webAction?: (options: WebCommandOptions) => Promise<{ exitCode: number }>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly setExitCode?: (code: number) => void;
}

function resolveCliArtifactRoot(options: CreateCliOptions): string {
  if (options.artifactRoot !== undefined) {
    if (!isAbsoluteArtifactRoot(options.artifactRoot)) {
      throw new Error('artifact-root must be an absolute path.');
    }
    return options.artifactRoot;
  }
  if (options.entryUrl !== undefined) {
    return resolveArtifactRootFromEntry(options.entryUrl);
  }
  throw new Error('CLI artifact-root is required.');
}

export function createCli(options: CreateCliOptions = {}): Command {
  const cli = new Command()
    .exitOverride()
    .name('echo-harness')
    .description(`${PROJECT_NAME}: ${PROJECT_TAGLINE}`)
    .version(options.version ?? PROJECT_VERSION);

  const setExitCode = options.setExitCode ?? ((code: number) => (process.exitCode = code));

  cli
    .command('run')
    .description('Run one autonomous coding turn in a fixed workspace.')
    .argument('<goal>', 'Goal for the agent to complete.')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to current directory).')
    .option(
      '--model <name>',
      'Override the configured model for this run. This does not query GET /models.',
    )
    .option('--base-url <url>', 'Override the OpenAI-compatible API base URL.')
    .addOption(
      new Option('--safety-mode <mode>', 'Safety mode.').choices([
        'safe',
        'balanced',
        'auto',
        'full-access',
      ]),
    )
    .option('--allow-full-access', 'Acknowledge Full Access risk for a non-interactive run.', false)
    .option('--max-steps <count>', 'Maximum model steps.', (value: string) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new InvalidArgumentError('max steps must be a positive integer');
      }
      return parsed;
    })
    .option('--verbose', 'Show additional bounded diagnostics.', false)
    .option('--non-interactive', 'Never prompt for approval.', false)
    .option('--no-color', 'Disable ANSI colors.')
    .action(
      async (
        goal: string,
        commandOptions: {
          workspace?: string;
          model?: string;
          baseUrl?: string;
          safetyMode?: SafetyMode;
          allowFullAccess: boolean;
          maxSteps?: number;
          verbose: boolean;
          nonInteractive: boolean;
          color: boolean;
        },
      ) => {
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        process.once('SIGINT', cancel);
        try {
          const interactive =
            !commandOptions.nonInteractive &&
            process.stdin.isTTY === true &&
            process.stderr.isTTY === true;
          const color =
            commandOptions.color &&
            interactive &&
            process.env['NO_COLOR'] === undefined &&
            process.env['CI'] === undefined;
          const runOptions: RunGoalOptions = {
            ...(commandOptions.workspace === undefined
              ? {}
              : { workspace: commandOptions.workspace }),
            ...(commandOptions.model === undefined ? {} : { model: commandOptions.model }),
            ...(commandOptions.baseUrl === undefined ? {} : { baseUrl: commandOptions.baseUrl }),
            ...(commandOptions.safetyMode === undefined
              ? {}
              : { safetyMode: commandOptions.safetyMode }),
            allowFullAccess: commandOptions.allowFullAccess,
            ...(commandOptions.maxSteps === undefined ? {} : { maxSteps: commandOptions.maxSteps }),
            verbose: commandOptions.verbose,
            color,
            interactive,
            signal: controller.signal,
            artifactRoot: resolveCliArtifactRoot(options),
          };
          const outcome = await (options.runAction ?? runGoal)(goal, runOptions);
          setExitCode(outcome.exitCode);
        } finally {
          process.off('SIGINT', cancel);
        }
      },
    );

  cli
    .command('chat')
    .description('Start or resume an interactive chat session in a fixed workspace.')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to current directory).')
    .option(
      '--resume <session-id>',
      'Resume an existing session in this workspace. Accepts the unique SESSION short id from the Chat banner.',
    )
    .option('--model <name>', 'Override the configured model name.')
    .option('--base-url <url>', 'Override the OpenAI-compatible API base URL.')
    .addOption(
      new Option('--safety-mode <mode>', 'Safety mode.').choices([
        'safe',
        'balanced',
        'auto',
        'full-access',
      ]),
    )
    .option('--max-steps <count>', 'Maximum model steps.', (value: string) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new InvalidArgumentError('max steps must be a positive integer');
      }
      return parsed;
    })
    .option('--verbose', 'Show additional bounded diagnostics.', false)
    .option('--no-color', 'Disable ANSI colors.')
    .action(
      async (commandOptions: {
        workspace?: string;
        resume?: string;
        model?: string;
        baseUrl?: string;
        safetyMode?: SafetyMode;
        maxSteps?: number;
        verbose: boolean;
        color: boolean;
      }) => {
        const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
        const color =
          commandOptions.color &&
          interactive &&
          process.env['NO_COLOR'] === undefined &&
          process.env['CI'] === undefined;
        const chatOptions: ChatCommandOptions = {
          ...(commandOptions.workspace === undefined
            ? {}
            : { workspace: commandOptions.workspace }),
          ...(commandOptions.resume === undefined ? {} : { resume: commandOptions.resume }),
          ...(commandOptions.model === undefined ? {} : { model: commandOptions.model }),
          ...(commandOptions.baseUrl === undefined ? {} : { baseUrl: commandOptions.baseUrl }),
          ...(commandOptions.safetyMode === undefined
            ? {}
            : { safetyMode: commandOptions.safetyMode }),
          ...(commandOptions.maxSteps === undefined ? {} : { maxSteps: commandOptions.maxSteps }),
          verbose: commandOptions.verbose,
          color,
          interactive,
          artifactRoot: resolveCliArtifactRoot(options),
        };
        const outcome = await (options.chatAction ?? runChat)(chatOptions);
        setExitCode(outcome.exitCode);
      },
    );

  cli
    .command('config')
    .description(
      'Create or update <artifact-root>/config/echo.config.json. Discover catalogs store only the default model; candidate lists are fetched later by chat /model.',
    )
    .action(async () => {
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once('SIGINT', cancel);
      try {
        const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
        const outcome = await (options.configAction ?? runConfigCommand)({
          artifactRoot: resolveCliArtifactRoot(options),
          interactive,
          signal: controller.signal,
        });
        setExitCode(outcome.exitCode);
      } finally {
        process.off('SIGINT', cancel);
      }
    });

  cli
    .command('web')
    .description(
      'Start a loopback Web console for one fixed workspace and open a one-time bootstrap URL.',
    )
    .option('-w, --workspace <path>', 'Workspace directory (defaults to current directory).')
    .option('--port <port>', 'Loopback TCP port (default: an ephemeral port).', (value: string) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new InvalidArgumentError('port must be an integer between 0 and 65535');
      }
      return parsed;
    })
    .option('--no-open', 'Print the URL without opening a browser.')
    .action(async (commandOptions: { workspace?: string; port?: number; open: boolean }) => {
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      // Windows cannot deliver SIGTERM to a listener; non-TTY stdin close is the smoke/CI stop.
      if (process.stdin.isTTY !== true) {
        process.stdin.resume();
        process.stdin.once('end', cancel);
      }
      try {
        const outcome = await (options.webAction ?? runWeb)({
          ...(commandOptions.workspace === undefined
            ? {}
            : { workspace: commandOptions.workspace }),
          ...(commandOptions.port === undefined ? {} : { port: commandOptions.port }),
          open: commandOptions.open,
          artifactRoot: resolveCliArtifactRoot(options),
          signal: controller.signal,
          ...(options.openUrl === undefined ? {} : { openUrl: options.openUrl }),
        });
        setExitCode(outcome.exitCode);
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        process.stdin.off('end', cancel);
      }
    });

  return cli;
}
