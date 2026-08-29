import * as path from 'node:path';

import type { P1ConfigSource, RenderCapabilities, RenderChunk } from '../contracts/index.js';

import {
  colorize,
  formatLabeled,
  formatLabeledBlock,
  formatRuleTitle,
  layoutOptions,
  stderrLines,
  stderrOpenLine,
  valueJoin,
} from './render-layout.js';
import { wrapToWidth } from './render-width.js';

export interface ChatBannerInput {
  readonly workspaceName: string;
  readonly sessionShortId: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly safetyMode: string;
  readonly resumed: boolean;
}

export interface StatusStripInput {
  readonly workspaceName: string;
  readonly model: string;
  readonly safetyMode: string;
  readonly contextPercent?: number;
}

export interface SessionStatusInput {
  readonly workspaceName: string;
  readonly sessionShortId: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly modelSource: P1ConfigSource;
  readonly safetyMode: string;
  readonly safetySource: P1ConfigSource;
  readonly turns: number;
  readonly contextUsed: number;
  readonly contextBudget: number;
  readonly lastTurn?: Readonly<{ status: string; steps: number; tools: number }>;
  readonly lastCheck?: Readonly<{ command: string; exitCode: number }>;
  readonly apiKey: 'configured' | 'missing';
}

export type SlashFeedbackInput =
  | Readonly<{ kind: 'model'; value: string }>
  | Readonly<{ kind: 'safety'; value: string }>
  | Readonly<{ kind: 'help'; lines: readonly string[] }>
  | Readonly<{ kind: 'info'; label: string; lines: readonly string[] }>
  | Readonly<{ kind: 'error'; label: string; message: string }>;

export function workspaceDisplayName(workspaceRoot: string): string {
  const base = path.basename(workspaceRoot.replaceAll('\\', '/'));
  return base.length === 0 ? 'workspace' : base;
}

export function youPromptText(unicode: boolean): string {
  return unicode ? 'YOU › ' : 'YOU > ';
}

export function renderChatBanner(
  input: ChatBannerInput,
  capabilities: RenderCapabilities,
): readonly RenderChunk[] {
  const options = layoutOptions(capabilities);
  const title = input.resumed ? 'ECHO Harness · resumed session' : 'ECHO Harness · chat';
  const join = valueJoin(options.unicode);
  const fields = [
    ...formatLabeled('WORKSPACE', input.workspaceName, options),
    ...formatLabeled('SESSION', input.sessionShortId, options),
    ...formatLabeled('PROVIDER', input.providerLabel, options),
    ...formatLabeled('MODEL', input.model, options),
    ...formatLabeled('SAFETY', input.safetyMode, options),
  ];
  return stderrLines([
    title,
    '',
    ...fields,
    '',
    `Type /help for commands${join}Ctrl+C cancels a running turn`,
  ]);
}

export function renderStatusStrip(
  input: StatusStripInput,
  capabilities: RenderCapabilities,
): readonly RenderChunk[] {
  const options = layoutOptions(capabilities);
  const join = valueJoin(options.unicode);
  const parts = [input.workspaceName, input.model, input.safetyMode];
  if (input.contextPercent !== undefined && input.contextPercent >= 70) {
    parts.push(`context ${String(Math.round(input.contextPercent))}%`);
  }
  const warning = input.contextPercent !== undefined && input.contextPercent >= 90;
  const wrapped = wrapToWidth(parts.join(join), Math.max(8, options.columns));
  return wrapped.map((line) => {
    const painted = warning
      ? colorize(line, 'yellow', options.color)
      : colorize(line, 'dim', options.color);
    return { channel: 'stderr', text: `${painted}\n` };
  });
}

export function renderYouPrompt(capabilities: RenderCapabilities): RenderChunk {
  return stderrOpenLine(youPromptText(capabilities.unicode));
}

export function renderIdlePrompt(
  input: StatusStripInput,
  capabilities: RenderCapabilities,
): readonly RenderChunk[] {
  return [...renderStatusStrip(input, capabilities), renderYouPrompt(capabilities)];
}

export function renderChatEcho(
  text: string,
  capabilities: RenderCapabilities,
): readonly RenderChunk[] {
  return stderrLines(formatLabeled('ECHO', text, layoutOptions(capabilities), 'cyan'));
}

export function renderSlashFeedback(
  input: SlashFeedbackInput,
  capabilities: RenderCapabilities,
): readonly RenderChunk[] {
  const options = layoutOptions(capabilities);
  if (input.kind === 'model') {
    return stderrLines(
      formatLabeledBlock('MODEL', [input.value, 'Applies to the next turn.'], options, 'cyan'),
    );
  }
  if (input.kind === 'safety') {
    return stderrLines(
      formatLabeledBlock('SAFETY', [input.value, 'Applies to the next turn.'], options, 'yellow'),
    );
  }
  if (input.kind === 'help') {
    return stderrLines(formatLabeledBlock('HELP', input.lines, options, 'cyan'));
  }
  if (input.kind === 'info') {
    return stderrLines(formatLabeledBlock(input.label, input.lines, options, 'cyan'));
  }
  return stderrLines(formatLabeled(input.label, input.message, options, 'red'));
}

export function renderSessionStatus(
  input: SessionStatusInput,
  capabilities: RenderCapabilities,
): readonly RenderChunk[] {
  const options = layoutOptions(capabilities);
  const percent =
    input.contextBudget > 0 ? Math.round((input.contextUsed / input.contextBudget) * 100) : 0;
  const lines = [
    formatRuleTitle('Session status', options, 'blueBold'),
    ...formatLabeled('WORKSPACE', input.workspaceName, options),
    ...formatLabeled('SESSION', input.sessionShortId, options),
    ...formatLabeled('PROVIDER', input.providerLabel, options),
    ...formatLabeled(
      'MODEL',
      `${input.model}${valueJoin(options.unicode)}${input.modelSource}`,
      options,
    ),
    ...formatLabeled(
      'SAFETY',
      `${input.safetyMode}${valueJoin(options.unicode)}${input.safetySource}`,
      options,
    ),
    ...formatLabeled('TURNS', String(input.turns), options),
    ...formatLabeled(
      'CONTEXT',
      `~${formatCount(input.contextUsed)} / ${formatCount(input.contextBudget)} tokens${valueJoin(options.unicode)}${String(percent)}%`,
      options,
    ),
  ];
  if (input.lastTurn !== undefined) {
    lines.push(
      ...formatLabeled(
        'LAST TURN',
        `${input.lastTurn.status}${valueJoin(options.unicode)}${String(input.lastTurn.steps)} steps${valueJoin(options.unicode)}${String(input.lastTurn.tools)} tools`,
        options,
      ),
    );
  }
  if (input.lastCheck !== undefined) {
    lines.push(
      ...formatLabeled(
        'LAST CHECK',
        `${input.lastCheck.command}${valueJoin(options.unicode)}exit ${String(input.lastCheck.exitCode)}`,
        options,
      ),
    );
  }
  lines.push(...formatLabeled('API KEY', input.apiKey, options));
  return stderrLines(lines);
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
