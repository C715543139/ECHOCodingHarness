import { describe, expect, it } from 'vitest';

import { projectTrace, projectTraceDetail } from '../../../src/web/trace/index.js';

import { resetTraceFixtureSequence, toolResult, traceEvent } from './trace-fixtures.js';

const WORKSPACE = String.raw`F:\Repo\ECHOCodingHarness`;
const OTHER_DRIVE = String.raw`F:\Other\orphan-project\src\main.ts`;
const UNC = String.raw`\\fileserver\share\secret.txt`;
const HOME_DIRECTORY = ['/', 'home', '/echo'].join('');
const POSIX_HOME = [HOME_DIRECTORY, '/workspace/src/app.ts'].join('');
const POSIX_OUTSIDE = ['/', 'home', '/other/outside/notes.md'].join('');
const REDACTION_MARKER = ['tok_', 'super_', 'secret_', '9f3a'].join('');
const REASONING = 'hidden-reasoning-payload';

const REDACTION = {
  workspaceRoot: WORKSPACE,
  homeDirectory: HOME_DIRECTORY,
  secrets: [REDACTION_MARKER],
} as const;

const ORIGINALS = [
  WORKSPACE,
  OTHER_DRIVE,
  UNC,
  POSIX_HOME,
  POSIX_OUTSIDE,
  REDACTION_MARKER,
  REASONING,
];

function leakEvents() {
  resetTraceFixtureSequence();
  return [
    traceEvent('turn.started', { goal: `fix ${OTHER_DRIVE} and ${POSIX_OUTSIDE}` }),
    traceEvent('step.started', { step: 1 }),
    traceEvent('model.started', { provider: 'openai-compatible', model: 'echo-model' }),
    traceEvent('model.text', {
      text: `I will edit ${WORKSPACE}\\src\\a.ts and skip ${UNC}`,
    }),
    traceEvent('model.reasoning', {
      reasoning: REASONING,
      reasoningDetails: [{ type: 'text', text: REASONING }],
    }),
    traceEvent('tool.requested', {
      call: {
        id: 'call-leak',
        name: 'run_command',
        arguments: {
          command: `Get-Content ${OTHER_DRIVE}`,
          nested: {
            workspace: `${WORKSPACE}\\README.md`,
            token: REDACTION_MARKER,
            reasoning_details: REASONING,
          },
        },
      },
      normalizedInput: {
        command: `pnpm test --prefix ${WORKSPACE}`,
        extra: {
          unc: UNC,
          posix: POSIX_HOME,
          secret: REDACTION_MARKER,
          reasoning_details: REASONING,
        },
      },
    }),
    traceEvent('tool.authorized', {
      toolCallId: 'call-leak',
      source: 'policy',
      policyRuleId: 'policy.command.test',
      reason: `Allowed under ${WORKSPACE}`,
    }),
    traceEvent('tool.completed', {
      durationMs: 9,
      result: toolResult('completed', {
        toolCallId: 'call-leak',
        toolName: 'write_file',
        summary: `Updated ${WORKSPACE}\\src\\a.ts`,
        content: `from ${POSIX_HOME}`,
        metadata: {
          path: `${WORKSPACE}\\src\\a.ts`,
          diff: `--- ${OTHER_DRIVE}\n+++ ${WORKSPACE}\\src\\a.ts\n+ok ${REDACTION_MARKER}`,
        },
      }),
    }),
    traceEvent('tool.requested', {
      call: { id: 'call-cmd', name: 'run_command', arguments: { command: `type ${UNC}` } },
      normalizedInput: { command: `type ${UNC}` },
    }),
    traceEvent('tool.completed', {
      durationMs: 4,
      result: toolResult('completed', {
        toolCallId: 'call-cmd',
        toolName: 'run_command',
        summary: `read ${UNC}`,
        metadata: { exitCode: 0, durationMs: 4 },
      }),
    }),
  ];
}

function assertNoOriginals(serialized: string): void {
  for (const original of ORIGINALS) {
    expect(serialized).not.toContain(original);
  }
  expect(serialized).not.toMatch(/reasoning_details/iu);
}

describe('Trace projection redaction', () => {
  it('redacts workspace, home, UNC, unknown drives, secrets, and reasoning from records and details', () => {
    const projection = projectTrace(leakEvents(), REDACTION);
    assertNoOriginals(JSON.stringify(projection.records));
    assertNoOriginals(JSON.stringify(projection.details));

    const user = projection.records.find((record) => record.type === 'user');
    expect(user?.parameterSummary).toMatch(/unavailable/u);

    const tool = projection.records.find(
      (record) => record.type === 'tool' && record.id.includes('call-leak'),
    );
    const toolDetail = tool === undefined ? undefined : projection.details[tool.id];
    expect(toolDetail).toBeDefined();
    const diff = toolDetail?.sections.find((section) => section.diff !== undefined)?.diff;
    expect(diff?.path).toBe('src/a.ts');
    expect(JSON.stringify(toolDetail)).not.toContain(WORKSPACE);
    expect(JSON.stringify(toolDetail)).not.toContain(OTHER_DRIVE);

    const verification = projection.records.find((record) => record.type === 'verification');
    const command = verification?.parameterSummary ?? '';
    expect(command).not.toContain(UNC);
    expect(command.includes('unavailable') || command.includes('<workspace>')).toBe(true);
  });

  it('applies the same redaction context to projectTraceDetail', () => {
    const events = leakEvents();
    const { records } = projectTrace(events, REDACTION);
    const agent = records.find((record) => record.type === 'agent');
    expect(agent).toBeDefined();
    if (agent === undefined) return;
    const detail = projectTraceDetail(events, agent.id, REDACTION);
    expect(detail).toBeDefined();
    assertNoOriginals(JSON.stringify(detail));
  });
});
