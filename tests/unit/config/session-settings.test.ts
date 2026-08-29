import { describe, expect, it } from 'vitest';

import {
  resolveNewSessionSetting,
  resolveResumeSessionSetting,
} from '../../../src/config/session-settings.js';

describe('session setting priority', () => {
  it('uses CLI over config for a new session', () => {
    expect(resolveNewSessionSetting('cli-model', 'file-model')).toEqual({
      value: 'cli-model',
      source: 'cli',
    });
    expect(resolveNewSessionSetting(undefined, 'file-model')).toEqual({
      value: 'file-model',
      source: 'config',
    });
    expect(resolveNewSessionSetting('safe', 'balanced')).toEqual({
      value: 'safe',
      source: 'cli',
    });
  });

  it('uses CLI over session last over config when resuming the same session', () => {
    expect(
      resolveResumeSessionSetting({
        cli: 'cli-model',
        session: 'session-model',
        config: 'file-model',
      }),
    ).toEqual({ value: 'cli-model', source: 'cli' });
    expect(
      resolveResumeSessionSetting({
        session: 'session-model',
        config: 'file-model',
      }),
    ).toEqual({ value: 'session-model', source: 'session' });
    expect(
      resolveResumeSessionSetting({
        session: '',
        config: 'file-model',
      }),
    ).toEqual({ value: 'file-model', source: 'config' });
    expect(
      resolveResumeSessionSetting({
        cli: 'auto',
        session: 'safe',
        config: 'balanced',
      }),
    ).toEqual({ value: 'auto', source: 'cli' });
  });
});
