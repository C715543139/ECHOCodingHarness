import type {
  AgentResult,
  EchoEvent,
  EventRenderer,
  RenderCapabilities,
  RenderChunk,
  ToolResultMessage,
} from '../contracts/index.js';
import { redactText, type RedactionOptions } from '../session/index.js';

const COLORS = {
  blue: '\u001B[34m',
  cyan: '\u001B[36m',
  green: '\u001B[32m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
  reset: '\u001B[0m',
} as const;

const MAX_DIFF_LINES = 16;
const MAX_DIFF_CHARS = 1_200;

type LabelColor = Exclude<keyof typeof COLORS, 'reset'>;
type ToolMetadata = Readonly<Record<string, string | number | boolean | null>>;

interface RequestedTool {
  readonly name: string;
  readonly summary: string;
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

function label(name: string, color: LabelColor, capabilities: RenderCapabilities): string {
  const padded = name.padEnd(7, ' ');
  return capabilities.color ? `${COLORS[color]}${padded}${COLORS.reset}` : padded;
}

function line(
  name: string,
  color: LabelColor,
  message: string,
  capabilities: RenderCapabilities,
): RenderChunk {
  return { channel: 'stderr', text: `${label(name, color, capabilities)}${message}\n` };
}

function detail(text: string): RenderChunk {
  return { channel: 'stderr', text: `  ${text}\n` };
}

function inputSummary(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const record = input as Readonly<Record<string, unknown>>;
  if (name === 'run_command' && typeof record['command'] === 'string') {
    return compact(record['command']);
  }
  if (typeof record['path'] === 'string') {
    if (name === 'search_text' && typeof record['query'] === 'string') {
      return `${JSON.stringify(compact(record['query'], 80))} in ${record['path'] || '.'}`;
    }
    return compact(record['path'] || '.');
  }
  if (name === 'search_text' && typeof record['query'] === 'string') {
    return JSON.stringify(compact(record['query'], 120));
  }
  return '';
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
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0ms';
  if (durationMs < 1_000) return `${String(Math.round(durationMs))}ms`;
  const seconds = durationMs / 1_000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
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

export class DefaultEventRenderer implements EventRenderer {
  private readonly redaction: RedactionOptions;
  private readonly requestedTools = new Map<string, RequestedTool>();
  private readonly changedFiles = new Set<string>();
  private lastVerification: { command: string; exitCode: number } | undefined;
  private textBuffer = '';
  private stepToolCalls = 0;
  private flushedProgress = false;
  private lastProgressText = '';
  private hadTruncation = false;
  private hadDenial = false;
  private hadLimit = false;

  constructor(redaction: RedactionOptions = {}) {
    this.redaction = redaction;
  }

  private sanitize(text: string): string {
    return defensiveRedact(text, this.redaction);
  }

  private resetStep(): void {
    this.textBuffer = '';
    this.stepToolCalls = 0;
    this.flushedProgress = false;
  }

  private flushProgress(capabilities: RenderCapabilities): readonly RenderChunk[] {
    if (this.flushedProgress) return [];
    const text = compact(this.sanitize(this.textBuffer));
    this.textBuffer = '';
    this.flushedProgress = true;
    if (isUnhelpfulProgress(text) || text === this.lastProgressText) return [];
    this.lastProgressText = text;
    return [line('ECHO', 'cyan', text, capabilities)];
  }

  renderEvent(event: EchoEvent, capabilities: RenderCapabilities): readonly RenderChunk[] {
    switch (event.type) {
      case 'session.started':
        return capabilities.verbose
          ? [
              line(
                'ECHO',
                'cyan',
                `session ${event.sessionId.slice(0, 12)} · safety ${event.payload.safetyMode}`,
                capabilities,
              ),
            ]
          : [];
      case 'turn.started':
        return [line('ECHO', 'cyan', compact(this.sanitize(event.payload.goal)), capabilities)];
      case 'step.started':
        this.resetStep();
        return [line('STEP', 'blue', String(event.payload.step), capabilities)];
      case 'context.projected':
        return capabilities.verbose
          ? [
              line(
                'CONTEXT',
                'blue',
                `${String(event.payload.approximateTokens)} approx tokens · ${String(event.payload.omittedEventCount)} omitted events · ${String(event.payload.truncationCount)} truncations`,
                capabilities,
              ),
            ]
          : [];
      case 'model.started':
        return capabilities.verbose
          ? [
              line(
                'MODEL',
                'blue',
                `${compact(event.payload.provider)} · ${compact(event.payload.model)}`,
                capabilities,
              ),
            ]
          : [];
      case 'model.text_delta':
        this.textBuffer += event.payload.delta;
        return [];
      case 'model.tool_call':
        this.stepToolCalls += 1;
        return capabilities.verbose
          ? [line('MODEL', 'blue', `requested ${compact(event.payload.call.name)}`, capabilities)]
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
          line(
            'MODEL',
            'blue',
            `${event.payload.finishReason}${usage.length === 0 ? '' : ` · ${usage.join(' · ')}`}`,
            capabilities,
          ),
        );
        return chunks;
      }
      case 'model.failed':
        return [
          line(
            event.payload.error.retryable ? 'WARN' : 'FAIL',
            event.payload.error.retryable ? 'yellow' : 'red',
            `${event.payload.error.category} · ${compact(this.sanitize(event.payload.error.message))}`,
            capabilities,
          ),
        ];
      case 'tool.requested': {
        const chunks: RenderChunk[] = [...this.flushProgress(capabilities)];
        const summary = inputSummary(event.payload.call.name, event.payload.normalizedInput);
        this.requestedTools.set(event.payload.call.id, {
          name: event.payload.call.name,
          summary,
        });
        chunks.push(
          line(
            'TOOL',
            'cyan',
            `${compact(event.payload.call.name)}${summary.length === 0 ? '' : `   ${this.sanitize(summary)}`}`,
            capabilities,
          ),
        );
        return chunks;
      }
      case 'approval.requested': {
        const requested = this.requestedTools.get(event.payload.toolCallId);
        const toolName = requested?.name ?? 'operation';
        const target =
          requested === undefined || requested.summary.length === 0 ? undefined : requested.summary;
        const targetLabel = toolName === 'run_command' ? 'Command' : 'Target';
        const lines = [
          `${compact(this.sanitize(toolName))} requires confirmation`,
          ...(target === undefined ? [] : [`  ${targetLabel}: ${compact(this.sanitize(target))}`]),
          `  Risk: ${compact(this.sanitize(event.payload.reason))}`,
          '  Scope: this operation / equivalent operations in this session',
        ];
        return [line('APPROVAL', 'yellow', lines.join('\n'), capabilities)];
      }
      case 'approval.granted':
        return [line('APPROVAL', 'green', `granted for ${event.payload.scope}`, capabilities)];
      case 'approval.denied':
        this.hadDenial = true;
        return [line('DENIED', 'red', compact(this.sanitize(event.payload.reason)), capabilities)];
      case 'tool.authorized':
        return capabilities.verbose
          ? [line('TOOL', 'cyan', `authorized by ${event.payload.source}`, capabilities)]
          : [];
      case 'tool.started':
        return [];
      case 'tool.completed':
        return this.renderCompleted(event.payload.result, event.payload.durationMs, capabilities);
      case 'tool.failed': {
        const category = metaString(event.payload.result.metadata, 'category');
        return [
          line(
            'FAIL',
            'red',
            `${category === undefined ? '' : `${category} · `}${compact(this.sanitize(event.payload.result.summary))}`,
            capabilities,
          ),
        ];
      }
      case 'tool.denied':
        this.hadDenial = true;
        return [
          line(
            'DENIED',
            'red',
            `${event.payload.hard ? 'hard deny · ' : ''}${compact(this.sanitize(event.payload.result.summary))}`,
            capabilities,
          ),
        ];
      case 'tool.cancelled':
        return [
          line(
            'CANCELLED',
            'yellow',
            `${event.payload.phase} · ${compact(this.sanitize(event.payload.result.summary))}`,
            capabilities,
          ),
        ];
      case 'limit.reached':
        this.hadLimit = true;
        return [
          line(
            'LIMIT',
            'yellow',
            `${event.payload.kind} · limit ${String(event.payload.limit)}`,
            capabilities,
          ),
        ];
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.cancelled':
        return [];
    }
  }

  renderResult(result: AgentResult, capabilities: RenderCapabilities): readonly RenderChunk[] {
    const chunks: RenderChunk[] = [];
    if (result.status === 'completed' && result.finalText !== undefined) {
      const finalText = this.sanitize(result.finalText);
      chunks.push({
        channel: 'stdout',
        text: finalText.endsWith('\n') ? finalText : `${finalText}\n`,
      });
    }

    const statusLabel =
      result.status === 'completed'
        ? ('DONE' as const)
        : result.status === 'cancelled'
          ? ('CANCELLED' as const)
          : result.status === 'limited'
            ? ('LIMIT' as const)
            : ('FAIL' as const);
    const statusColor: LabelColor =
      statusLabel === 'DONE' ? 'green' : statusLabel === 'FAIL' ? 'red' : 'yellow';
    const changes =
      this.changedFiles.size === 0
        ? 'no file changes'
        : plural(this.changedFiles.size, 'file changed', 'files changed');
    let summary = `${label(statusLabel, statusColor, capabilities)}${result.stopReason}\n  ${plural(result.steps, 'step')} · ${plural(result.toolCalls, 'tool call')} · ${changes}\n`;
    if (this.lastVerification !== undefined) {
      summary += `  Verification: ${this.sanitize(this.lastVerification.command)} · exit ${String(this.lastVerification.exitCode)}\n`;
    }
    if (this.hadDenial) summary += '  one or more operations were denied\n';
    if (this.hadLimit) summary += '  a step, repetition, or budget limit was reached\n';
    if (this.hadTruncation) summary += '  one or more outputs were truncated\n';
    if (result.error !== undefined) {
      summary += `  ${result.error.category}: ${compact(this.sanitize(result.error.message))}\n`;
      if (capabilities.verbose) summary += `  code: ${compact(result.error.code)}\n`;
    }
    chunks.push({ channel: 'stderr', text: summary });
    return chunks;
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
    if (result.toolName === 'run_command' && exitCode !== undefined && requested !== undefined) {
      this.lastVerification = { command: requested.summary, exitCode };
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
          : `${plural(totalLines, 'line')} read`;
      return this.okChunks(message, result.truncated === true, capabilities);
    }
    if (result.toolName === 'search_text') {
      const matches = metaNumber(result.metadata, 'totalMatches') ?? 0;
      const omitted = metaNumber(result.metadata, 'omittedMatches') ?? 0;
      const message =
        omitted > 0
          ? `${plural(matches, 'match', 'matches')} (${String(omitted)} omitted)`
          : plural(matches, 'match', 'matches');
      return this.okChunks(message, result.truncated === true || omitted > 0, capabilities);
    }
    if (result.toolName === 'list_files') {
      const entries = metaNumber(result.metadata, 'totalEntries') ?? 0;
      return this.okChunks(
        plural(entries, 'entry', 'entries'),
        result.truncated === true,
        capabilities,
      );
    }
    return this.okChunks(
      compact(this.sanitize(result.summary)),
      result.truncated === true,
      capabilities,
    );
  }

  private okChunks(
    message: string,
    truncated: boolean,
    capabilities: RenderCapabilities,
  ): readonly RenderChunk[] {
    const chunks: RenderChunk[] = [line('OK', 'green', message, capabilities)];
    if (truncated) chunks.push(line('WARN', 'yellow', 'tool output was truncated', capabilities));
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
    const status = failed ? ('FAIL' as const) : ('OK' as const);
    const color: LabelColor = failed ? 'red' : 'green';
    const headline =
      exitCode === undefined
        ? compact(this.sanitize(result.summary))
        : `exit ${String(exitCode)} · ${formatDuration(elapsed)}`;
    const chunks: RenderChunk[] = [line(status, color, headline, capabilities)];
    const evidence = extractTestEvidence(stdout, stderr);
    if (evidence !== undefined) chunks.push(detail(this.sanitize(evidence)));
    else if (failed) {
      const stderrLine = compact(this.sanitize(stderr), 160);
      if (stderrLine.length > 0) chunks.push(detail(`stderr: ${stderrLine}`));
    }
    if (truncated) {
      const original =
        (metaNumber(result.metadata, 'stdoutOriginalChars') ?? 0) +
        (metaNumber(result.metadata, 'stderrOriginalChars') ?? 0);
      chunks.push(
        line(
          'WARN',
          'yellow',
          `output truncated: yes${original > 0 ? ` · original ${String(original)} chars` : ''}`,
          capabilities,
        ),
      );
    }
    return chunks;
  }

  private renderFileChange(
    result: ToolResultMessage<'completed'>,
    capabilities: RenderCapabilities,
  ): readonly RenderChunk[] {
    const relativePath = this.sanitize(metaString(result.metadata, 'path') ?? result.summary);
    const additions = metaNumber(result.metadata, 'additions') ?? 0;
    const deletions = metaNumber(result.metadata, 'deletions') ?? 0;
    const chunks: RenderChunk[] = [
      line(
        'OK',
        'green',
        `${compact(relativePath)} · +${String(additions)} -${String(deletions)}`,
        capabilities,
      ),
    ];
    const diff = metaString(result.metadata, 'diff');
    if (diff !== undefined && diff.length > 0) {
      for (const diffLine of displayDiff(
        this.sanitize(diff),
        metaNumber(result.metadata, 'omittedDiffChars'),
      )) {
        chunks.push(detail(diffLine));
      }
    }
    if (result.truncated === true || (metaNumber(result.metadata, 'omittedDiffChars') ?? 0) > 0) {
      this.hadTruncation = true;
      chunks.push(line('WARN', 'yellow', 'diff truncated', capabilities));
    }
    return chunks;
  }
}
