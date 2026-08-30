// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../../../src/web/client/App.js';

describe('Web application shell', () => {
  afterEach(() => {
    cleanup();
  });

  it('identifies the P2 local console without claiming implemented features', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'ECHO Coding Harness' })).toBeTruthy();
    expect(screen.getByText('Local Web console foundation')).toBeTruthy();
  });
});
