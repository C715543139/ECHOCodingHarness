import { describe, expect, expectTypeOf, it } from 'vitest';

import type { EndpointFingerprint } from '../../../src/contracts/index.js';
import { createEndpointFingerprint, createProviderIdentity } from '../../../src/session/index.js';

describe('createEndpointFingerprint', () => {
  it('hashes scheme, host, and default port without path, userinfo, or raw URL', () => {
    const withPath = createEndpointFingerprint('https://api.example.test/v1');
    const withUserinfo = createEndpointFingerprint(
      'https://user:secret-token@api.example.test:443/other',
    );
    const otherHost = createEndpointFingerprint('https://other.example.test/v1');

    expect(withPath).toBe(withUserinfo);
    expect(withPath).not.toBe(otherHost);
    expect(withPath).toMatch(/^[0-9a-f]{64}$/u);
    expect(withPath).not.toContain('https://');
    expect(withPath).not.toContain('api.example.test');
    expect(withPath).not.toContain('secret-token');
    expect(withPath).not.toContain('@');
    expectTypeOf(withPath).toEqualTypeOf<EndpointFingerprint>();
    type StringIsFingerprint = string extends EndpointFingerprint ? true : false;
    expectTypeOf<StringIsFingerprint>().toEqualTypeOf<false>();
  });

  it('treats equivalent default ports as the same identity and rejects a credential-bearing host string', () => {
    const identity = createProviderIdentity('http://models.local/v1');
    expect(identity).toEqual({
      kind: 'openai-compatible',
      name: 'openai-compatible',
      endpointFingerprint: createEndpointFingerprint('http://models.local:80/ignored'),
    });
    try {
      createEndpointFingerprint('not-a-url');
      throw new Error('expected an invalid URL to fail closed');
    } catch (error) {
      expect(error).toMatchObject({ category: 'configuration', code: 'CONFIG_INVALID_URL' });
    }
  });
});
