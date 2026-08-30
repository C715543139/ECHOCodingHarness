import {
  createWebServer,
  defaultWebAssetRoot,
  type CreateWebServerOptions,
  type StartedWebServer,
} from '../web/server/index.js';

import { resolveWorkspace } from './harness-runtime.js';

export interface WebCommandOptions {
  readonly workspace?: string;
  readonly port?: number;
  readonly artifactRoot: string;
  readonly cwd?: string;
  readonly signal: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly createServer?: (options: CreateWebServerOptions) => Promise<StartedWebServer>;
  readonly writeOutput?: (text: string) => void;
}

export async function runWeb(options: WebCommandOptions): Promise<{ exitCode: number }> {
  const workspaceRoot = await resolveWorkspace(options.workspace ?? options.cwd ?? process.cwd());
  const createServer = options.createServer ?? createWebServer;
  const writeOutput = options.writeOutput ?? ((text: string) => process.stdout.write(text));
  const server = await createServer({
    workspaceRoot,
    artifactRoot: options.artifactRoot,
    assetRoot: defaultWebAssetRoot(options.artifactRoot),
    port: options.port ?? 0,
    env: options.env ?? process.env,
  });
  writeOutput(`${server.bootstrapUrl}\n`);
  try {
    if (!options.signal.aborted) {
      await new Promise<void>((resolvePromise) => {
        options.signal.addEventListener('abort', () => resolvePromise(), { once: true });
      });
    }
  } finally {
    await server.close();
  }
  return { exitCode: 0 };
}
