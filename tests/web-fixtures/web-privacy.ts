export const WEB_PRIVACY_FORBIDDEN = [
  /ECHO_API_KEY/iu,
  /sk-[A-Za-z0-9]/u,
  /C:\\Users\\/iu,
  /\/home\//u,
  /model\.reasoning/iu,
  /reasoning_delta/iu,
  /reasoningContent/iu,
  /reasoning_details/iu,
  /at\s+\S+\s+\(/u,
] as const;

export function serializedWebValue(value: unknown): string {
  return JSON.stringify(value);
}

export function findWebPrivacyLeaks(serialized: string): readonly string[] {
  return WEB_PRIVACY_FORBIDDEN.filter((pattern) => pattern.test(serialized)).map(
    (pattern) => pattern.source,
  );
}
