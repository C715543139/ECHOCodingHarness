export type SessionId = string;
export type TurnId = string;
export type StepId = string;
export type ToolCallId = string;
export type EventId = string;

declare const endpointFingerprintBrand: unique symbol;

/**
 * Irreversible Provider endpoint identifier. Never a raw URL, credential,
 * userinfo, or a reversible encoding of those values. P1-1A owns the hash.
 */
export type EndpointFingerprint = string & {
  readonly [endpointFingerprintBrand]: true;
};

export interface ProviderIdentity {
  readonly kind: 'openai-compatible';
  readonly name: 'openai-compatible';
  readonly endpointFingerprint: EndpointFingerprint;
}
