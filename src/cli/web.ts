import { CLI_EXIT_CODES } from '../contracts/index.js';
import {
  createWebServer,
  defaultWebAssetRoot,
  type CreateWebServerOptions,
  type StartedWebServer,
} from '../web/server/index.js';

import { resolveWorkspace } from './harness-runtime.js';
import {
  WEB_OPEN_ERROR_CODES,
  createPlatformUrlOpener,
  verifyLoopbackBootstrapUrl,
  webOpenErrorMessage,
  type WebOpenErrorCode,
} from './open-loopback-url.js';

export interface WebCommandOptions {
  readonly workspace?: string;
  readonly port?: number;
  readonly open?: boolean;
  readonly artifactRoot: string;
  readonly cwd?: string;
  readonly signal: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly createServer?: (options: CreateWebServerOptions) => Promise<StartedWebServer>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly writeOutput?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

export interface WebCommandOutcome {
  readonly exitCode: number;
  readonly errorCode?: WebOpenErrorCode;
}

export async function runWeb(options: WebCommandOptions): Promise<WebCommandOutcome> {
  const workspaceRoot = await resolveWorkspace(options.workspace ?? options.cwd ?? process.cwd());
  const createServer = options.createServer ?? createWebServer;
  const writeOutput = options.writeOutput ?? ((text: string) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text: string) => process.stderr.write(text));
  const shouldOpen = options.open !== false;
  const openUrl = options.openUrl ?? createPlatformUrlOpener();
  const server = await createServer({
    workspaceRoot,
    artifactRoot: options.artifactRoot,
    assetRoot: defaultWebAssetRoot(options.artifactRoot),
    port: options.port ?? 0,
    env: options.env ?? process.env,
  });

  const verified = verifyLoopbackBootstrapUrl(server.bootstrapUrl, {
    port: server.port,
    token: server.bootstrapToken,
  });
  if (!verified.ok) {
    await server.close();
    writeError(`${webOpenErrorMessage(WEB_OPEN_ERROR_CODES.invalidUrl)}\n`);
    return {
      exitCode: CLI_EXIT_CODES.usageOrConfig,
      errorCode: WEB_OPEN_ERROR_CODES.invalidUrl,
    };
  }

  if (shouldOpen) {
    try {
      await openUrl(verified.url);
    } catch {
      await server.close();
      writeError(`${webOpenErrorMessage(WEB_OPEN_ERROR_CODES.openFailed)}\n`);
      return {
        exitCode: CLI_EXIT_CODES.unclassified,
        errorCode: WEB_OPEN_ERROR_CODES.openFailed,
      };
    }
  }

  writeOutput(`${verified.url}\n`);
  try {
    if (!options.signal.aborted) {
      await new Promise<void>((resolvePromise) => {
        options.signal.addEventListener('abort', () => resolvePromise(), { once: true });
      });
    }
  } finally {
    await server.close();
  }
  return { exitCode: CLI_EXIT_CODES.success };
}
