import type {
  AgentResult,
  EchoEvent,
  EventRenderer,
  RenderCapabilities,
  RenderChunk,
  ToolResultMessage,
} from '../contracts/index.js';
import { redactText, type RedactionOptions } from '../session/index.js';

import {
  colorStatus,
  formatLabeled,
  formatLabeledBlock,
  formatRuleTitle,
  layoutOptions,
  stderrLines,
  stderrOpenLine,
  valueJoin,
  type LabelColor,
  type LayoutOptions,
} from './render-layout.js';

export type RenderSurface = 'run' | 'chat';

const MAX_DIFF_LINES = 16;
const MAX_DIFF_CHARS = 1_200;

type ToolMetadata = Readonly<Record<string, string | number | boolean | null>>;

interface RequestedTool {
  readonly summary: string;
}

export const APPROVAL_CHOICES = 'Approve [y] once / [s] session / [n] deny';

export function formatApprovalQuestion(capabilities: RenderCapabilities): string {
  const marker = capabilities.unicode ? '›' : '>';
  const body = `${APPROVAL_CHOICES} ${marker}`;
  const lines = formatLabeled('', body, layoutOptions(capabilities));
  return `${lines.at(-1) ?? body} `;
}

function compact(value: string, maximum = 240): string {
  const oneLine = [...value.replace(/\s+/gu, ' ')]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  return oneLine.length <= maximum ? oneLine : `${oneLine.slice(0, maximum - 3)}...`;
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(value)} ${value === 1 ? singular : pluralForm}`;
}

function metaString(metadata: ToolMetadata | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function metaNumber(metadata: ToolMetadata | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function metaBoolean(metadata: ToolMetadata | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0 ms';
  if (durationMs < 1_000) return `${String(Math.round(durationMs))} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
}

export function extractTestEvidence(stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`;
  const fail = text.match(/^(?:#\s+|ℹ\s+)?fail\s+(\d+)\s*$/mu);
  const pass = text.match(/^(?:#\s+|ℹ\s+)?pass\s+(\d+)\s*$/mu);
  if (fail?.[1] !== undefined && pass?.[1] !== undefined) {
    const failed = Number(fail[1]);
    const passed = Number(pass[1]);
    if (failed > 0) return plural(failed, 'test failed', 'tests failed');
    return plural(passed, 'test passed', 'tests passed');
  }

  const vitestFailed = text.match(/Tests?\s+(\d+)\s+failed/u);
  const vitestPassed = text.match(/(\d+)\s+passed/u);
  if (vitestFailed?.[1] !== undefined) {
    const failed = Number(vitestFailed[1]);
    if (failed > 0) return plural(failed, 'test failed', 'tests failed');
  }
  if (vitestPassed?.[1] !== undefined && /\bpassed\b/u.test(text) && !/\bfailed\b/iu.test(text)) {
    return plural(Number(vitestPassed[1]), 'test passed', 'tests passed');
  }
  return undefined;
}

function isUnhelpfulProgress(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return true;
  return /^(?:thinking|reasoning|analysis|thought)\.?$/iu.test(normalized);
}

function defensiveRedact(text: string, options: RedactionOptions): string {
  return redactText(text, options)
    .replace(/[A-Za-z]:\\Users\\[^\\/\s]+/giu, '<home>')
    .replace(/\/Users\/[^/\s]+/gu, '<home>')
    .replace(/\/home\/[^/\s]+/gu, '<home>');
}

function displayDiff(diff: string, omittedChars: number | undefined): readonly string[] {
  const lines = diff.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  const visible = lines.slice(0, MAX_DIFF_LINES);
  const clipped: string[] = [];
  let used = 0;
  for (const current of visible) {
    if (used + current.length > MAX_DIFF_CHARS) {
      clipped.push('[truncated]');
      break;
    }
    clipped.push(current);
    used += current.length + 1;
  }
  if (lines.length > clipped.length || (omittedChars !== undefined && omittedChars > 0)) {
    if (clipped.at(-1) !== '[truncated]') clipped.push('[truncated]');
  }
  return clipped;
}

function commandExitFailed(result: ToolResultMessage<'completed'>): boolean {
  const exitCode = metaNumber(result.metadata, 'exitCode');
  return exitCode !== undefined && exitCode !== 0;
}

function toolField(name: string, input: unknown): { field: string; summary: string } | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  if (name === 'run_command' && typeof record['command'] === 'string') {
    return { field: 'COMMAND', summary: compact(record['command']) };
  }
  if (name === 'search_text') {
    const query = typeof record['query'] === 'string' ? compact(record['query'], 80) : undefined;
    const searchPath = typeof record['path'] === 'string' ? record['path'] || '.' : undefined;
    if (query !== undefined && searchPath !== undefined) {
      return { field: 'QUERY', summary: `${JSON.stringify(query)} in ${searchPath}` };
    }
    if (query !== undefined)
      return { field: 'QUERY', summary: JSON.stringify(compact(query, 120)) };
  }
  if (typeof record['path'] === 'string') {
    const field = name === 'apply_patch' ? 'TARGET' : 'PATH';
    return { field, summary: compact(record['path'] || '.') };
  }
  return undefined;
}

function nestedField(name: string, value: string): string {
  return `${name.padEnd(7, ' ')}${value}`;
}

export class DefaultEventRenderer implements EventRenderer {
  private readonly redaction: RedactionOptions;
  private readonly surface: RenderSurface;
  private readonly requestedTools = new Map<string, RequestedTool>();
  private readonly changedFiles = new Set<string>();
  private lastVerification: { command: string; exitCode: number; durationMs?: number } | undefined;
  private lastDenialDetail: string | undefined;
  private textBuffer = '';
  private stepToolCalls = 0;
  private flushedProgress = false;
  private lastProgressText = '';
  private hadTruncation = false;
  private hadDenial = false;
  private hadLimit = false;

  constructor(redaction: RedactionOptions = {}, surface: RenderSurface = 'run') {
    this.redaction = redaction;
    this.surface = surface;
  }

  private sanitize(text: string): string {
    return defensiveRedact(text, this.redaction);
  }

  private resetStep(): void {
    this.textBuffer = '';
    this.stepToolCalls = 0;
    this.flushedProgress = false;
  }

  private emit(
    label: string,
    body: string,
    capabilities: RenderCapabilities,
    color?: LabelColor,
  ): readonly RenderChunk[] {
    return stderrLines(formatLabeled(label, body, layoutOptions(capabilities), color));
  }

  private emitBlock(
    label: string,
    lines: readonly string[],
    capabilities: RenderCapabilities,
    color?: LabelColor,
  ): readonly RenderChunk[] {
    return stderrLines(formatLabeledBlock(label, lines, layoutOptions(capabilities), color));
  }

  private join(capabilities: RenderCapabilities, parts: readonly string[]): string {
    return parts.filter((part) => part.length > 0).join(valueJoin(capabilities.unicode));
  }

  private flushProgress(capabilities: RenderCapabilities): readonly RenderChunk[] {
    if (this.flushedProgress) return [];
    const text = compact(this.sanitize(this.textBuffer));
    this.textBuffer = '';
    this.flushedProgress = true;
    if (isUnhelpfulProgress(text) || text === this.lastProgressText) return [];
    this.lastProgressText = text;
    return this.emit('ECHO', text, capabilities, 'cyan');
  }

  renderEvent(event: EchoEvent, capabilities: RenderCapabilities): readonly RenderChunk[] {
    switch (event.type) {
      case 'session.started':
        return capabilities.verbose
          ? this.emit(
              'SESSION',
              this.join(capabilities, [
                event.sessionId.slice(0, 12),
                `safety ${event.payload.safetyMode}`,
              ]),
              capabilities,
              'cyan',
            )
          : [];
      case 'session.resumed':
      case 'model.changed':
      case 'safety.changed':
        return [];
      case 'turn.started':
        if (this.surface === 'chat') return [];
        return this.emit('ECHO', compact(this.sanitize(event.payload.goal)), capabilities, 'cyan');
      case 'step.started': {
        this.resetStep();
        const options = layoutOptions(capabilities);
        return [
          { channel: 'stderr', text: '\n' },
          ...stderrLines([
            formatRuleTitle(`Step ${String(event.payload.step)}`, options, 'blueBold'),
          ]),
        ];
      }
      case 'context.projected':
        return capabilities.verbose
          ? this.emit(
              'CONTEXT',
              this.join(capabilities, [
                `${String(event.payload.approximateTokens)} approx tokens`,
                `${String(event.payload.omittedEventCount)} omitted events`,
                `${String(event.payload.truncationCount)} truncations`,
              ]),
              capabilities,
              'blue',
            )
          : [];
      case 'model.started':
        return capabilities.verbose
          ? this.emit(
              'MODEL',
              this.join(capabilities, [
                compact(event.payload.provider),
                compact(event.payload.model),
              ]),
              capabilities,
              'blue',
            )
          : [];
      case 'model.text_delta':
        this.textBuffer += event.payload.delta;
        return [];
      case 'model.tool_call':
        this.stepToolCalls += 1;
        return capabilities.verbose
          ? this.emit(
              'MODEL',
              `requested ${compact(event.payload.call.name)}`,
              capabilities,
              'blue',
            )
          : [];
      case 'model.completed': {
        const chunks: RenderChunk[] = [];
        if (this.stepToolCalls > 0) chunks.push(...this.flushProgress(capabilities));
        if (!capabilities.verbose) return chunks;
        const usage = [
          event.payload.inputTokens === undefined
            ? undefined
            : `${String(event.payload.inputTokens)} input`,
          event.payload.outputTokens === undefined
            ? undefined
            : `${String(event.payload.outputTokens)} output`,
        ].filter((item): item is string => item !== undefined);
        chunks.push(
          ...this.emit(
            'MODEL',
            this.join(capabilities, [event.payload.finishReason, ...usage]),
            capabilities,
            'blue',
          ),
        );
        return chunks;
      }
      case 'model.failed':
        return this.emit(
          event.payload.error.retryable ? 'WARN' : 'FAIL',
          this.join(capabilities, [
            event.payload.error.category,
            compact(this.sanitize(event.payload.error.message)),
          ]),
          capabilities,
          event.payload.error.retryable ? 'yellow' : 'red',
        );
      case 'tool.requested': {
        const chunks: RenderChunk[] = [...this.flushProgress(capabilities)];
        const field = toolField(event.payload.call.name, event.payload.normalizedInput);
        this.requestedTools.set(event.payload.call.id, {
          summary: field?.summary ?? '',
        });
        chunks.push(...this.emit('TOOL', compact(event.payload.call.name), capabilities, 'cyan'));
        if (field !== undefined && field.summary.length > 0) {
          chunks.push(...this.emit(field.field, this.sanitize(field.summary), capabilities));
        }
        return chunks;
      }
      case 'approval.requested':
        return this.renderApproval(event.payload.reason, capabilities);
      case 'approval.granted':
        return this.emit('APPROVED', event.payload.scope, capabilities, 'green');
      case 'approval.denied':
        this.hadDenial = true;
        this.lastDenialDetail = compact(this.sanitize(event.payload.reason));
        return this.emit('DENIED', this.lastDenialDetail, capabilities, 'red');
      case 'tool.authorized':
        return capabilities.verbose
          ? this.emit('TOOL', `authorized by ${event.payload.source}`, capabilities, 'cyan')
          : [];
      case 'tool.started':
        return [];
      case 'tool.completed':
        return this.renderCompleted(event.payload.result, event.payload.durationMs, capabilities);
      case 'tool.failed': {
        const category = metaString(event.payload.result.metadata, 'category');
        return this.emit(
          'RESULT',
          this.join(capabilities, [
            colorStatus('FAIL', capabilities.color),
            ...(category === undefined ? [] : [category]),
            compact(this.sanitize(event.payload.result.summary)),
          ]),
          capabilities,
          'red',
        );
      }
      case 'tool.denied': {
        this.hadDenial = true;
        const summary = compact(this.sanitize(event.payload.result.summary));
        this.lastDenialDetail = summary;
        const headline = event.payload.hard ? 'Hard policy' : summary;
        const extra = event.payload.hard && summary.length > 0 ? [summary] : [];
        return this.emitBlock('DENIED', [headline, ...extra], capabilities, 'red');
      }
      case 'tool.cancelled':
        return this.emit(
          'CANCELLED',
          this.join(capabilities, [
            event.payload.phase,
            compact(this.sanitize(event.payload.result.summary)),
          ]),
          capabilities,
          'yellow',
        );
      case 'limit.reached':
        this.hadLimit = true;
        return this.emit(
          'LIMIT',
          this.join(capabilities, [event.payload.kind, `limit ${String(event.payload.limit)}`]),
          capabilities,
          'yellow',
        );
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.cancelled':
        return [];
    }
  }

  renderResult(result: AgentResult, capabilities: RenderCapabilities): readonly RenderChunk[] {
    const chunks: RenderChunk[] = [];
    const options = layoutOptions(capabilities);
    if (result.status === 'completed' && result.finalText !== undefined) {
      const finalText = this.sanitize(result.finalText);
      if (this.surface === 'chat') {
        chunks.push(
          { channel: 'stderr', text: '\n' },
          ...this.emit('ECHO', finalText.trimEnd(), capabilities, 'cyan'),
        );
      } else {
        chunks.push({
          channel: 'stdout',
          text: finalText.endsWith('\n') ? finalText : `${finalText}\n`,
        });
      }
    }

    chunks.push({ channel: 'stderr', text: '\n' });
    chunks.push(
      ...stderrLines([
        formatRuleTitle(this.resultTitle(result), options, this.resultColor(result)),
      ]),
    );
    chunks.push(...this.resultRows(result, capabilities, options));
    return chunks;
  }

  private resultTitle(result: AgentResult): string {
    const kind = this.surface === 'chat' ? 'Turn' : 'Run';
    if (result.status === 'completed') return `${kind} completed`;
    if (result.status === 'cancelled') return `${kind} cancelled`;
    if (result.status === 'limited') return `${kind} limited`;
    return `${kind} failed`;
  }

  private resultColor(result: AgentResult): LabelColor {
    if (result.status === 'completed') return 'green';
    if (result.status === 'failed') return 'red';
    return 'yellow';
  }

  private resultRows(
    result: AgentResult,
    capabilities: RenderCapabilities,
    options: LayoutOptions,
  ): readonly RenderChunk[] {
    const rows: string[] = [];
    if (result.status !== 'completed') {
      rows.push(...formatLabeled('REASON', result.stopReason, options, 'red'));
    }
    rows.push(...formatLabeled('STEPS', String(result.steps), options));
    rows.push(...formatLabeled('TOOLS', String(result.toolCalls), options));
    rows.push(
      ...formatLabeled(
        'CHANGES',
        this.changedFiles.size === 0 ? 'none' : plural(this.changedFiles.size, 'file', 'files'),
        options,
      ),
    );
    rows.push(...this.verificationRows(result, capabilities, options));
    if (this.hadDenial) {
      rows.push(
        ...formatLabeledBlock(
          'DETAIL',
          [
            'One or more operations were denied.',
            ...(this.lastDenialDetail === undefined ? [] : [this.lastDenialDetail]),
          ],
          options,
        ),
      );
    }
    if (this.hadLimit) {
      rows.push(
        ...formatLabeled('DETAIL', 'A step, repetition, or budget limit was reached.', options),
      );
    }
    if (this.hadTruncation) {
      rows.push(...formatLabeled('DETAIL', 'One or more outputs were truncated.', options));
    }
    if (result.error !== undefined) {
      rows.push(
        ...formatLabeled(
          'DETAIL',
          `${result.error.category}${valueJoin(options.unicode)}${compact(this.sanitize(result.error.message))}`,
          options,
        ),
      );
      if (capabilities.verbose) {
        rows.push(
          ...formatLabeled(
            'DETAIL',
            `code${valueJoin(options.unicode)}${compact(result.error.code)}`,
            options,
          ),
        );
      }
    }
    return stderrLines(rows);
  }

  private verificationRows(
    result: AgentResult,
    capabilities: RenderCapabilities,
    options: LayoutOptions,
  ): readonly string[] {
    const verified =
      result.status === 'completed' &&
      this.lastVerification !== undefined &&
      this.lastVerification.exitCode === 0;
    if (verified && this.lastVerification !== undefined) {
      return formatLabeled(
        'VERIFIED',
        this.verificationText(this.lastVerification, capabilities),
        options,
        'green',
      );
    }
    if (this.lastVerification !== undefined) {
      return formatLabeled(
        'LAST CHECK',
        this.verificationText(this.lastVerification, capabilities),
        options,
      );
    }
    return formatLabeled('NOT VERIFIED', '', options, 'yellow');
  }

  private verificationText(
    verification: { command: string; exitCode: number; durationMs?: number },
    capabilities: RenderCapabilities,
  ): string {
    const parts = [
      this.sanitize(verification.command),
      `exit ${String(verification.exitCode)}`,
      ...(verification.durationMs === undefined ? [] : [formatDuration(verification.durationMs)]),
    ];
    return this.join(capabilities, parts);
  }

  private renderApproval(reason: string, capabilities: RenderCapabilities): readonly RenderChunk[] {
    const options = layoutOptions(capabilities);
    const marker = capabilities.unicode ? '›' : '>';
    const risk = nestedField('Risk', compact(this.sanitize(reason)));
    const scope = nestedField('Scope', 'once or equivalent operations in this session');
    const prompt = `${APPROVAL_CHOICES} ${marker} `;
    const lines = capabilities.interactive
      ? formatLabeledBlock(
          'APPROVAL',
          ['Required', risk, scope, prompt.trimEnd()],
          options,
          'yellow',
        )
      : formatLabeledBlock(
          'APPROVAL',
          ['Required', risk, scope, APPROVAL_CHOICES],
          options,
          'yellow',
        );
    if (!capabilities.interactive) return stderrLines(lines);
    const closed = lines.slice(0, -1);
    return [...stderrLines(closed), stderrOpenLine(formatApprovalQuestion(capabilities))];
  }

  private renderCompleted(
    result: ToolResultMessage<'completed'>,
    durationMs: number,
    capabilities: RenderCapabilities,
  ): readonly RenderChunk[] {
    const requested = this.requestedTools.get(result.toolCallId);
    const pathValue = metaString(result.metadata, 'path');
    if (
      (result.toolName === 'write_file' || result.toolName === 'apply_patch') &&
      pathValue !== undefined
    ) {
      this.changedFiles.add(pathValue);
    }
    const exitCode = metaNumber(result.metadata, 'exitCode');
    const elapsed = metaNumber(result.metadata, 'durationMs') ?? durationMs;
    if (result.toolName === 'run_command' && exitCode !== undefined && requested !== undefined) {
      this.lastVerification = { command: requested.summary, exitCode, durationMs: elapsed };
    }
    if (result.truncated === true) this.hadTruncation = true;

    if (result.toolName === 'run_command') {
      return this.renderCommand(result, durationMs, capabilities);
    }
    if (result.toolName === 'apply_patch' || result.toolName === 'write_file') {
      return this.renderFileChange(result, capabilities);
    }
    if (result.toolName === 'read_file') {
      const totalLines = metaNumber(result.metadata, 'totalLines');
      const message =
        totalLines === undefined
          ? compact(this.sanitize(result.summary))
          : this.join(capabilities, [
              colorStatus('OK', capabilities.color),
              `${plural(totalLines, 'line')} read`,
            ]);
      return this.resultChunks(message, result.truncated === true, capabilities);
    }
    if (result.toolName === 'search_text') {
      const matches = metaNumber(result.metadata, 'totalMatches') ?? 0;
      const omitted = metaNumber(result.metadata, 'omittedMatches') ?? 0;
      const message =
        omitted > 0
          ? `${plural(matches, 'match', 'matches')} (${String(omitted)} omitted)`
          : plural(matches, 'match', 'matches');
      return this.resultChunks(message, result.truncated === true || omitted > 0, capabilities);
    }
    if (result.toolName === 'list_files') {
      const entries = metaNumber(result.metadata, 'totalEntries') ?? 0;
      return this.resultChunks(
        plural(entries, 'entry', 'entries'),
        result.truncated === true,
        capabilities,
      );
    }
    return this.resultChunks(
      compact(this.sanitize(result.summary)),
      result.truncated === true,
      capabilities,
    );
  }

  private resultChunks(
    message: string,
    truncated: boolean,
    capabilities: RenderCapabilities,
  ): readonly RenderChunk[] {
    const chunks: RenderChunk[] = [...this.emit('RESULT', message, capabilities, 'green')];
    if (truncated) {
      chunks.push(...this.emit('WARN', 'tool output was truncated', capabilities, 'yellow'));
    }
    return chunks;
  }

  private renderCommand(
    result: ToolResultMessage<'completed'>,
    durationMs: number,
    capabilities: RenderCapabilities,
  ): readonly RenderChunk[] {
    const exitCode = metaNumber(result.metadata, 'exitCode');
    const elapsed = metaNumber(result.metadata, 'durationMs') ?? durationMs;
    const failed = commandExitFailed(result);
    const stdout = metaString(result.metadata, 'stdout') ?? '';
    const stderr = metaString(result.metadata, 'stderr') ?? '';
    const truncated =
      result.truncated === true ||
      metaBoolean(result.metadata, 'stdoutTruncated') ||
      metaBoolean(result.metadata, 'stderrTruncated');
    if (truncated) this.hadTruncation = true;
    const status = failed ? 'FAIL' : 'OK';
    const headline = this.join(capabilities, [
      colorStatus(status, capabilities.color),
      ...(exitCode === undefined
        ? [compact(this.sanitize(result.summary))]
        : [`exit ${String(exitCode)}`]),
      formatDuration(elapsed),
    ]);
    const extra: string[] = [];
    const evidence = extractTestEvidence(stdout, stderr);
    if (evidence !== undefined) extra.push(this.sanitize(evidence));
    else if (failed) {
      const stderrLine = compact(this.sanitize(stderr), 160);
      if (stderrLine.length > 0) extra.push(`stderr: ${stderrLine}`);
    }
    const chunks: RenderChunk[] = [
      ...this.emitBlock('RESULT', [headline, ...extra], capabilities, failed ? 'red' : 'green'),
    ];
    if (truncated) {
      const original =
        (metaNumber(result.metadata, 'stdoutOriginalChars') ?? 0) +
        (metaNumber(result.metadata, 'stderrOriginalChars') ?? 0);
      chunks.push(
        ...this.emit(
          'WARN',
          original > 0
            ? `output truncated: yes${valueJoin(capabilities.unicode)}original ${String(original)} chars`
            : 'output truncated: yes',
          capabilities,
          'yellow',
        ),
      );
    }
    return chunks;
  }

  private renderFileChange(
    result: ToolResultMessage<'completed'>,
    capabilities: RenderCapabilities,
  ): readonly RenderChunk[] {
    const additions = metaNumber(result.metadata, 'additions') ?? 0;
    const deletions = metaNumber(result.metadata, 'deletions') ?? 0;
    const headline = this.join(capabilities, [
      colorStatus('OK', capabilities.color),
      '1 file changed',
      `+${String(additions)} -${String(deletions)}`,
    ]);
    const extra: string[] = [];
    const diff = metaString(result.metadata, 'diff');
    if (diff !== undefined && diff.length > 0) {
      extra.push(
        ...displayDiff(this.sanitize(diff), metaNumber(result.metadata, 'omittedDiffChars')),
      );
    }
    const chunks: RenderChunk[] = [
      ...this.emitBlock('RESULT', [headline, ...extra], capabilities, 'green'),
    ];
    if (result.truncated === true || (metaNumber(result.metadata, 'omittedDiffChars') ?? 0) > 0) {
      this.hadTruncation = true;
      chunks.push(...this.emit('WARN', 'diff truncated', capabilities, 'yellow'));
    }
    return chunks;
  }
}

export function formatDiagnostic(
  label: 'FAIL' | 'WARN',
  message: string,
  capabilities: RenderCapabilities,
): string {
  return `${formatLabeled(label, message, layoutOptions(capabilities), label === 'FAIL' ? 'red' : 'yellow').join('\n')}\n`;
}
