import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { APPROVAL_CHOICES } from '../../../src/cli/event-renderer.js';
import { InteractiveApprovalHandler } from '../../../src/cli/run.js';
import type { ApprovalChoice } from '../../../src/contracts/index.js';

function approvalRequest() {
  return {
    turnId: 'turn-1',
    toolCall: {
      id: 'call-1',
      name: 'run_command',
      arguments: { command: 'node --version' },
    },
    normalizedInput: { command: 'node --version' },
    reason: 'The command effect is not explicitly classified as safe.',
    approvalKey: 'approval:test',
    signal: new AbortController().signal,
  };
}

describe('InteractiveApprovalHandler', () => {
  it.each<readonly [input: string, expected: ApprovalChoice]>([
    ['n', 'deny'],
    ['y', 'once'],
    ['s', 'session'],
  ])(
    'prints choices before reading %s and preserves its approval meaning',
    async (input, expected) => {
      const stdin = new PassThrough();
      let stderr = '';
      const output = new Writable({
        write(chunk, _encoding, callback) {
          stderr += String(chunk);
          callback();
        },
      });
      const handler = new InteractiveApprovalHandler(stdin, output);

      const answer = handler.requestApproval(approvalRequest());

      expect(stderr).toContain(APPROVAL_CHOICES);
      stdin.end(`${input}\n`);
      await expect(answer).resolves.toBe(expected);
    },
  );
});
