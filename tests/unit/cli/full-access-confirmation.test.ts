import { describe, expect, it, vi } from 'vitest';

import {
  FULL_ACCESS_RISK_NOTICE,
  resolveCliFullAccessConfirmation,
} from '../../../src/cli/full-access-confirmation.js';

describe('CLI Full Access confirmation', () => {
  it('shows the complete risk notice and records an interactive human confirmation', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await resolveCliFullAccessConfirmation({
      targetMode: 'full-access',
      explicitMode: 'full-access',
      interactive: true,
      allowFullAccess: false,
      confirm,
    });

    expect(FULL_ACCESS_RISK_NOTICE).toMatch(/modify or delete files/iu);
    expect(FULL_ACCESS_RISK_NOTICE).toMatch(/install software/iu);
    expect(FULL_ACCESS_RISK_NOTICE).toMatch(/network/iu);
    expect(FULL_ACCESS_RISK_NOTICE).toMatch(/Git/iu);
    expect(FULL_ACCESS_RISK_NOTICE).toMatch(/arbitrary model-generated commands/iu);
    expect(FULL_ACCESS_RISK_NOTICE).toMatch(/not an OS sandbox/iu);
    expect(confirm).toHaveBeenCalledWith(FULL_ACCESS_RISK_NOTICE);
    expect(result).toEqual({
      ok: true,
      confirmation: { acceptedRisk: true, source: 'cli-interactive' },
    });
  });

  it('does not grant interactive Full Access when the human declines', async () => {
    await expect(
      resolveCliFullAccessConfirmation({
        targetMode: 'full-access',
        explicitMode: undefined,
        interactive: true,
        allowFullAccess: false,
        confirm: vi.fn().mockResolvedValue(false),
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('requires both non-interactive flags and rejects an orphan acknowledgement', async () => {
    await expect(
      resolveCliFullAccessConfirmation({
        targetMode: 'full-access',
        explicitMode: 'full-access',
        interactive: false,
        allowFullAccess: false,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      resolveCliFullAccessConfirmation({
        targetMode: 'full-access',
        explicitMode: undefined,
        interactive: false,
        allowFullAccess: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      resolveCliFullAccessConfirmation({
        targetMode: 'full-access',
        explicitMode: 'full-access',
        interactive: false,
        allowFullAccess: true,
      }),
    ).resolves.toEqual({
      ok: true,
      confirmation: { acceptedRisk: true, source: 'cli-flag' },
    });
    await expect(
      resolveCliFullAccessConfirmation({
        targetMode: 'balanced',
        explicitMode: 'balanced',
        interactive: false,
        allowFullAccess: true,
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
