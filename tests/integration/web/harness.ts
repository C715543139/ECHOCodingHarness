import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writePersistentConfigFile } from '../../../src/config/index.js';
import {
  WEB_AUTH_COOKIE,
  WEB_SERVER_HOST,
  createWebServer,
  type StartedWebServer,
} from '../../../src/web/server/index.js';
import type { ExtensionAdministrationPort } from '../../../src/web/server/index.js';

export interface TestInjectOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload?: unknown;
  readonly cookies?: string;
}

export interface TestWebServer {
  readonly server: StartedWebServer;
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
  readonly origin: string;
  readonly host: string;
  bootstrap(): Promise<string>;
  inject(options: TestInjectOptions): Promise<{
    readonly statusCode: number;
    readonly headers: OutgoingHttpHeaders;
    readonly body: string;
    json(): unknown;
  }>;
}

export async function startTestWebServer(
  overrides: {
    readonly heartbeatIntervalMs?: number;
    readonly withAssets?: boolean;
    readonly env?: Record<string, string | undefined>;
    readonly extensionAdministration?: ExtensionAdministrationPort;
  } = {},
): Promise<TestWebServer> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'echo-web-ws-'));
  const artifactRoot = await mkdtemp(path.join(tmpdir(), 'echo-web-art-'));
  await writePersistentConfigFile(artifactRoot, {
    baseUrl: 'https://provider.example/v1',
    model: 'fake-model',
    modelCatalog: { source: 'discover' },
    safetyMode: 'balanced',
  });
  const assetRoot =
    overrides.withAssets === true ? path.join(artifactRoot, 'web-assets') : undefined;
  if (assetRoot !== undefined) {
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(assetRoot, 'index.html'), '<!doctype html><title>echo</title>');
  }
  const server = await createWebServer({
    workspaceRoot,
    artifactRoot,
    ...(assetRoot === undefined ? {} : { assetRoot }),
    port: 0,
    env: overrides.env ?? { ECHO_API_KEY: 'test-key' },
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 20,
    ...(overrides.extensionAdministration === undefined
      ? {}
      : { extensionAdministration: overrides.extensionAdministration }),
  });
  const origin = `http://${WEB_SERVER_HOST}:${String(server.port)}`;
  const host = `${WEB_SERVER_HOST}:${String(server.port)}`;
  return {
    server,
    workspaceRoot,
    artifactRoot,
    origin,
    host,
    async bootstrap() {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: {
          host,
          origin,
          'content-type': 'application/json',
        },
        payload: { token: server.bootstrapToken },
      });
      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (response.statusCode !== 204 || header === undefined) {
        throw new Error(`bootstrap failed: ${String(response.statusCode)} ${response.body}`);
      }
      const match = new RegExp(`${WEB_AUTH_COOKIE}=([^;]+)`, 'u').exec(header);
      if (match?.[1] === undefined) throw new Error('bootstrap cookie missing');
      return match[1];
    },
    inject(options) {
      const headers = {
        host,
        ...options.headers,
        ...(options.cookies === undefined
          ? {}
          : { cookie: `${WEB_AUTH_COOKIE}=${options.cookies}` }),
      };
      if (options.payload === undefined) {
        return server.app.inject({ method: options.method, url: options.url, headers });
      }
      return server.app.inject({
        method: options.method,
        url: options.url,
        headers,
        payload: options.payload as string | object,
      });
    },
  };
}
