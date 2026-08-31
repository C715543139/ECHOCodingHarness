import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import type { FullAccessConfirmation, SafetyMode } from '../contracts/index.js';

export const FULL_ACCESS_RISK_NOTICE =
  'FULL ACCESS can modify or delete files, install software, access the network, operate on Git, and execute arbitrary model-generated commands. It is not an OS sandbox and changes may be unrecoverable.';

export type FullAccessConfirmer = (notice: string) => Promise<boolean>;

export type CliFullAccessConfirmationResult =
  | Readonly<{ ok: true; confirmation?: FullAccessConfirmation }>
  | Readonly<{ ok: false; message: string }>;

export async function resolveCliFullAccessConfirmation(input: {
  readonly targetMode: SafetyMode;
  readonly explicitMode: SafetyMode | undefined;
  readonly interactive: boolean;
  readonly allowFullAccess: boolean;
  readonly confirm?: FullAccessConfirmer;
}): Promise<CliFullAccessConfirmationResult> {
  if (input.targetMode !== 'full-access') {
    return input.allowFullAccess
      ? {
          ok: false,
          message: '--allow-full-access is valid only with --safety-mode full-access.',
        }
      : { ok: true };
  }

  if (input.interactive) {
    if (input.confirm === undefined || !(await input.confirm(FULL_ACCESS_RISK_NOTICE))) {
      return { ok: false, message: 'Full Access was not confirmed; no session was changed.' };
    }
    return {
      ok: true,
      confirmation: { acceptedRisk: true, source: 'cli-interactive' },
    };
  }

  if (input.explicitMode !== 'full-access' || !input.allowFullAccess) {
    return {
      ok: false,
      message:
        'Non-interactive Full Access requires both --safety-mode full-access and --allow-full-access.',
    };
  }
  return { ok: true, confirmation: { acceptedRisk: true, source: 'cli-flag' } };
}

export function createInteractiveFullAccessConfirmer(
  input: Readable = process.stdin,
  output: Writable = process.stderr,
  signal?: AbortSignal,
): FullAccessConfirmer {
  return async (notice) => {
    const terminal = createInterface({ input, output, terminal: true });
    try {
      output.write(`\n${notice}\n`);
      const prompt = 'Type FULL ACCESS to continue: ';
      const answer =
        signal === undefined
          ? await terminal.question(prompt)
          : await terminal.question(prompt, { signal });
      return answer.trim() === 'FULL ACCESS';
    } finally {
      terminal.close();
    }
  };
}
