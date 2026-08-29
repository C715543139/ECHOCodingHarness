import { createHash } from 'node:crypto';

import {
  CONFIG_ERROR_CODES,
  type EndpointFingerprint,
  type ProviderIdentity,
} from '../contracts/index.js';

import { configurationError } from './errors.js';

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  http: '80',
  https: '443',
};

function canonicalEndpoint(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw configurationError(
      CONFIG_ERROR_CODES.invalidUrl,
      'The Provider URL is not a valid absolute URL.',
      error,
    );
  }

  const scheme = parsed.protocol.replace(/:$/u, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw configurationError(
      CONFIG_ERROR_CODES.invalidUrl,
      'The Provider URL must use http or https.',
    );
  }

  const host = parsed.hostname.trim().toLowerCase();
  if (host.length === 0) {
    throw configurationError(
      CONFIG_ERROR_CODES.invalidUrl,
      'The Provider URL must include a hostname.',
    );
  }

  const port = parsed.port.length === 0 ? (DEFAULT_PORTS[scheme] ?? '') : parsed.port;
  return `openai-compatible|${scheme}|${host}|${port}`;
}

export function createEndpointFingerprint(baseUrl: string): EndpointFingerprint {
  const digest = createHash('sha256').update(canonicalEndpoint(baseUrl), 'utf8').digest('hex');
  return digest as EndpointFingerprint;
}

export function createProviderIdentity(baseUrl: string): ProviderIdentity {
  return {
    kind: 'openai-compatible',
    name: 'openai-compatible',
    endpointFingerprint: createEndpointFingerprint(baseUrl),
  };
}

export function providerIdentitiesEqual(left: ProviderIdentity, right: ProviderIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.endpointFingerprint === right.endpointFingerprint
  );
}
