import type {
  AgentResult,
  EchoEvent,
  EventRenderer,
  RenderCapabilities,
  RenderChunk,
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

type LabelColor = Exclude<keyof typeof COLORS, 'reset'>;

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

export class DefaultEventRenderer implements EventRenderer {
  private readonly redaction: RedactionOptions;
  private readonly requestedTools = new Map<string, RequestedTool>();
  private readonly changedFiles = new Set<string>();
  private lastVerification: { command: string; exitCode: number } | undefined;

  constructor(redaction: RedactionOptions = {}) {
    this.redaction = redaction;
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
        return [
          line(
            'ECHO',
            'cyan',
            compact(redactText(event.payload.goal, this.redaction)),
            capabilities,
          ),
        ];
      case 'step.started':
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
      case 'model.tool_call':
        return capabilities.verbose
          ? [line('MODEL', 'blue', `requested ${compact(event.payload.call.name)}`, capabilities)]
          : [];
      case 'model.completed': {
        if (!capabilities.verbose) return [];
        const usage = [
          event.payload.inputTokens === undefined
            ? undefined
            : `${String(event.payload.inputTokens)} input`,
          event.payload.outputTokens === undefined
            ? undefined
            : `${String(event.payload.outputTokens)} output`,
        ].filter((item): item is string => item !== undefined);
        return [
          line(
            'MODEL',
            'blue',
            `${event.payload.finishReason}${usage.length === 0 ? '' : ` · ${usage.join(' · ')}`}`,
            capabilities,
          ),
        ];
      }
      case 'model.failed':
        return [
          line(
            event.payload.error.retryable ? 'WARN' : 'FAIL',
            event.payload.error.retryable ? 'yellow' : 'red',
            `${event.payload.error.category} · ${compact(event.payload.error.message)}`,
            capabilities,
          ),
        ];
      case 'tool.requested': {
        const summary = inputSummary(event.payload.call.name, event.payload.normalizedInput);
        this.requestedTools.set(event.payload.call.id, {
          name: event.payload.call.name,
          summary,
        });
        return [
          line(
            'TOOL',
            'cyan',
            `${compact(event.payload.call.name)}${summary.length === 0 ? '' : `   ${redactText(summary, this.redaction)}`}`,
            capabilities,
          ),
        ];
      }
      case 'approval.requested': {
        const requested = this.requestedTools.get(event.payload.toolCallId);
        const operation =
          requested === undefined
            ? 'operation'
            : `${requested.name}${requested.summary.length === 0 ? '' : ` · ${requested.summary}`}`;
        return [
          line(
            'APPROVAL',
            'yellow',
            `${compact(redactText(operation, this.redaction))} requires confirmation\n  Risk: ${compact(redactText(event.payload.reason, this.redaction))}\n  Scope: deny / once / session`,
            capabilities,
          ),
        ];
      }
      case 'approval.granted':
        return [line('APPROVAL', 'green', `granted for ${event.payload.scope}`, capabilities)];
      case 'approval.denied':
        return [line('DENIED', 'red', compact(event.payload.reason), capabilities)];
      case 'tool.authorized':
        return capabilities.verbose
          ? [line('TOOL', 'cyan', `authorized by ${event.payload.source}`, capabilities)]
          : [];
      case 'tool.started':
      case 'model.text_delta':
        return [];
      case 'tool.completed': {
        const result = event.payload.result;
        const requested = this.requestedTools.get(result.toolCallId);
        const pathValue = result.metadata?.['path'];
        if (
          (result.toolName === 'write_file' || result.toolName === 'apply_patch') &&
          typeof pathValue === 'string'
        ) {
          this.changedFiles.add(pathValue);
        }
        const exitCode = result.metadata?.['exitCode'];
        if (
          result.toolName === 'run_command' &&
          typeof exitCode === 'number' &&
          requested !== undefined
        ) {
          this.lastVerification = { command: requested.summary, exitCode };
        }
        const chunks: RenderChunk[] = [
          line('OK', 'green', compact(redactText(result.summary, this.redaction)), capabilities),
        ];
        if (result.truncated === true) {
          chunks.push(line('WARN', 'yellow', 'tool output was truncated', capabilities));
        }
        return chunks;
      }
      case 'tool.failed': {
        const category = event.payload.result.metadata?.['category'];
        return [
          line(
            'FAIL',
            'red',
            `${typeof category === 'string' ? `${category} · ` : ''}${compact(redactText(event.payload.result.summary, this.redaction))}`,
            capabilities,
          ),
        ];
      }
      case 'tool.denied':
        return [
          line(
            'DENIED',
            'red',
            `${event.payload.hard ? 'hard deny · ' : ''}${compact(redactText(event.payload.result.summary, this.redaction))}`,
            capabilities,
          ),
        ];
      case 'tool.cancelled':
        return [
          line(
            'CANCELLED',
            'yellow',
            `${event.payload.phase} · ${compact(event.payload.result.summary)}`,
            capabilities,
          ),
        ];
      case 'limit.reached':
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
      const finalText = redactText(result.finalText, this.redaction);
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
      summary += `  Verification: ${redactText(this.lastVerification.command, this.redaction)} · exit ${String(this.lastVerification.exitCode)}\n`;
    }
    if (result.error !== undefined) {
      summary += `  ${result.error.category}: ${compact(redactText(result.error.message, this.redaction))}\n`;
      if (capabilities.verbose) summary += `  code: ${compact(result.error.code)}\n`;
    }
    chunks.push({ channel: 'stderr', text: summary });
    return chunks;
  }
}
