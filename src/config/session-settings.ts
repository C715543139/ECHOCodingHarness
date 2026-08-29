import type { EffectiveRuntimeSetting } from '../contracts/application.js';

function isPresent<T>(value: T | undefined): value is T {
  if (value === undefined) return false;
  return typeof value !== 'string' || value.length > 0;
}

/**
 * New-session priority: CLI explicit args over the persistent config file.
 * Built-in field defaults are not a source.
 */
export function resolveNewSessionSetting<T>(
  cliValue: T | undefined,
  configValue: T,
): EffectiveRuntimeSetting<T> {
  if (cliValue !== undefined) {
    return { value: cliValue, source: 'cli' };
  }
  return { value: configValue, source: 'config' };
}

/**
 * Resume priority: CLI explicit args over the same session's last value over
 * the persistent config file. "Session last" never inherits another session.
 */
export function resolveResumeSessionSetting<T>(input: {
  readonly cli?: T;
  readonly session?: T;
  readonly config: T;
}): EffectiveRuntimeSetting<T> {
  if (input.cli !== undefined) {
    return { value: input.cli, source: 'cli' };
  }
  if (isPresent(input.session)) {
    return { value: input.session, source: 'session' };
  }
  return { value: input.config, source: 'config' };
}
