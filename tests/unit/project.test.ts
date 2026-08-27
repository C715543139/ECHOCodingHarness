import { describe, expect, it } from 'vitest';

import { PROJECT_NAME, PROJECT_TAGLINE, PROJECT_VERSION } from '../../src/core/project.js';

describe('project metadata', () => {
  it('exposes the stable product identity', () => {
    expect(PROJECT_NAME).toBe('ECHO Harness');
    expect(PROJECT_TAGLINE).toContain('local-first autonomous coding agent');
    expect(PROJECT_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });
});
