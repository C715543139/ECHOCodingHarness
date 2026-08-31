import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type {
  EchoError,
  ExtensionManifest,
  ToolContext,
  ToolExecution,
} from '../contracts/index.js';
import { normalizeToolInput } from '../tools/index.js';

import { ExtensionWorkerError, type ExtensionWorkerErrorCode } from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import { EXTENSION_WORKER_SOURCE } from './worker-source.js';

const MESSAGE_ID_LIMIT = 128;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_CANCEL_GRACE_MS = 100;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 500;
const MAX_WORKER_INPUT_BYTES = 1024 * 1024;
const ERROR_CATEGORIES = new Set([
  'configuration',
  'provider_auth',
  'provider_rate_limit',
  'provider_network',
  'provider_protocol',
  'invalid_tool_input',
  'workspace_violation',
  'policy_denied',
  'tool_timeout',
  'tool_execution',
  'storage',
  'cancelled',
  'internal',
]);

export interface ExtensionWorkerSpec {
  readonly extensionId: string;
  readonly extensionRoot: string;
  readonly workspaceRoot: string;
  readonly manifest: ExtensionManifest;
}

export interface ExtensionWorkerFault {
  readonly extensionId: string;
  readonly code: ExtensionWorkerErrorCode;
  readonly message: string;
}

export interface ExtensionWorkerHostOptions {
  readonly initializeTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onFault?: (fault: ExtensionWorkerFault) => void | Promise<void>;
}

interface InitPending {
  readonly kind: 'initialize';
  readonly resolve: () => void;
  readonly reject: (error: ExtensionWorkerError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ExecutePending {
  readonly kind: 'execute';
  readonly limits: ToolContext['limits'];
  readonly resolve: (execution: ToolExecution<unknown>) => void;
  readonly abortListener: () => void;
  readonly signal: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  settledEarly: boolean;
}

type PendingRequest = InitPending | ExecutePending;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MESSAGE_ID_LIMIT;
}

function sanitizedWorkerEnvironment(): Record<string, string> {
  const allowed = [
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'PATH',
    'PATHEXT',
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_ENV',
  ];
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function failed(
  error: EchoError,
  summary = error.message,
  truncated = false,
): ToolExecution<unknown> {
  return { status: 'failed', summary, error, truncated };
}

function boundedText(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, maximum - 1))}…`, truncated: true };
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ExtensionWorkerError(
      'WORKER_PROTOCOL_ERROR',
      'Extension worker returned unknown execution fields.',
    );
  }
}

function normalizeEchoError(value: unknown): EchoError {
  if (!isRecord(value)) {
    throw new ExtensionWorkerError('WORKER_PROTOCOL_ERROR', 'Worker error must be an object.');
  }
  assertKeys(value, ['category', 'code', 'message', 'retryable', 'details']);
  if (
    typeof value['category'] !== 'string' ||
    !ERROR_CATEGORIES.has(value['category']) ||
    typeof value['code'] !== 'string' ||
    value['code'].length === 0 ||
    typeof value['message'] !== 'string' ||
    typeof value['retryable'] !== 'boolean'
  ) {
    throw new ExtensionWorkerError('WORKER_PROTOCOL_ERROR', 'Worker error fields are invalid.');
  }
  const details = value['details'];
  let normalizedDetails: EchoError['details'];
  if (details !== undefined) {
    if (
      !isRecord(details) ||
      Object.values(details).some(
        (item) =>
          item !== null &&
          typeof item !== 'string' &&
          typeof item !== 'number' &&
          typeof item !== 'boolean',
      )
    ) {
      throw new ExtensionWorkerError('WORKER_PROTOCOL_ERROR', 'Worker error details are invalid.');
    }
    normalizedDetails = details as EchoError['details'];
  }
  return {
    category: value['category'] as EchoError['category'],
    code: value['code'],
    message: value['message'],
    retryable: value['retryable'],
    ...(normalizedDetails === undefined ? {} : { details: normalizedDetails }),
  };
}

function normalizeExecution(value: unknown, maximum: number): ToolExecution<unknown> {
  if (!isRecord(value) || (value['status'] !== 'completed' && value['status'] !== 'failed')) {
    throw new ExtensionWorkerError(
      'WORKER_PROTOCOL_ERROR',
      'Extension handler must return a ToolExecution object.',
    );
  }
  if (typeof value['summary'] !== 'string' || typeof value['truncated'] !== 'boolean') {
    throw new ExtensionWorkerError(
      'WORKER_PROTOCOL_ERROR',
      'Extension ToolExecution summary or truncated flag is invalid.',
    );
  }
  const budget = Math.max(16, maximum);
  const boundedSummary = boundedText(value['summary'], Math.max(8, Math.floor(budget / 3)));
  if (value['status'] === 'completed') {
    assertKeys(value, ['status', 'summary', 'data', 'truncated']);
    if (!Object.hasOwn(value, 'data')) {
      throw new ExtensionWorkerError('WORKER_PROTOCOL_ERROR', 'Completed execution requires data.');
    }
    const normalized = normalizeToolInput(value['data']);
    if (!normalized.ok) {
      throw new ExtensionWorkerError(
        'WORKER_PROTOCOL_ERROR',
        'Extension execution data must be plain JSON.',
      );
    }
    const encoded = JSON.stringify(normalized.value);
    const remaining = Math.max(8, budget - boundedSummary.text.length);
    const boundedData = boundedText(encoded, remaining);
    return {
      status: 'completed',
      summary: boundedSummary.text,
      data: boundedData.truncated ? boundedData.text : normalized.value,
      truncated: value['truncated'] || boundedSummary.truncated || boundedData.truncated,
    };
  }
  assertKeys(value, ['status', 'summary', 'error', 'truncated']);
  const error = normalizeEchoError(value['error']);
  const boundedMessage = boundedText(
    error.message,
    Math.max(8, budget - boundedSummary.text.length),
  );
  return {
    status: 'failed',
    summary: boundedSummary.text,
    error: { ...error, message: boundedMessage.text },
    truncated: value['truncated'] || boundedSummary.truncated || boundedMessage.truncated,
  };
}

async function resolveEntry(spec: ExtensionWorkerSpec): Promise<string> {
  const root = await fs.realpath(spec.extensionRoot);
  const candidate = path.resolve(root, ...spec.manifest.entry.split('/'));
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ExtensionWorkerError(
      'WORKER_INITIALIZATION_FAILED',
      'Extension entry escapes its installed root.',
    );
  }
  const stats = await fs.lstat(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ExtensionWorkerError(
      'WORKER_INITIALIZATION_FAILED',
      'Extension entry must be a regular file and cannot be a link.',
    );
  }
  const canonical = await fs.realpath(candidate);
  if (path.relative(root, canonical).startsWith('..')) {
    throw new ExtensionWorkerError(
      'WORKER_INITIALIZATION_FAILED',
      'Extension entry resolves outside its installed root.',
    );
  }
  return canonical;
}

export class ExtensionWorkerHost {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cancelGraceMs: number;
  private readonly shutdownTimeoutMs: number;
  private faultReported = false;
  private shuttingDown = false;
  private isClosed = false;

  private constructor(
    readonly extensionId: string,
    private readonly worker: Worker,
    private readonly toolNames: ReadonlySet<string>,
    private readonly options: ExtensionWorkerHostOptions,
  ) {
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.on('message', (message: unknown) => this.onMessage(message));
    worker.on('error', (error) => this.fault('WORKER_CRASHED', 'Extension worker crashed.', error));
    worker.on('exit', (code) => {
      if (!this.shuttingDown && !this.isClosed) {
        this.fault(
          'WORKER_CRASHED',
          `Extension worker exited unexpectedly with code ${String(code)}.`,
        );
      }
    });
  }

  static async open(
    spec: ExtensionWorkerSpec,
    options: ExtensionWorkerHostOptions = {},
  ): Promise<ExtensionWorkerHost> {
    const entry = await resolveEntry(spec);
    const worker = new Worker(EXTENSION_WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      env: sanitizedWorkerEnvironment(),
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
      workerData: {
        entryUrl: pathToFileURL(entry).href,
        toolNames: spec.manifest.tools.map((tool) => tool.name),
        workspaceRoot: spec.workspaceRoot,
      },
    });
    const host = new ExtensionWorkerHost(
      spec.extensionId,
      worker,
      new Set(spec.manifest.tools.map((tool) => tool.name)),
      options,
    );
    await host.initialize(options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
    return host;
  }

  get activeCallCount(): number {
    return [...this.pending.values()].filter((pending) => pending.kind === 'execute').length;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolExecution<unknown>> {
    if (this.isClosed) {
      return failed({
        category: 'tool_execution',
        code: 'EXTENSION_WORKER_CLOSED',
        message: 'The extension worker is not available.',
        retryable: false,
      });
    }
    if (!this.toolNames.has(toolName)) {
      return failed({
        category: 'invalid_tool_input',
        code: 'EXTENSION_TOOL_NOT_FOUND',
        message: 'The extension does not provide this tool.',
        retryable: false,
      });
    }
    const normalized = normalizeToolInput(input);
    if (!normalized.ok) return failed(normalized.error);
    if (Buffer.byteLength(JSON.stringify(normalized.value), 'utf8') > MAX_WORKER_INPUT_BYTES) {
      return failed({
        category: 'invalid_tool_input',
        code: 'EXTENSION_INPUT_TOO_LARGE',
        message: 'Extension input exceeds the worker message limit.',
        retryable: false,
      });
    }
    if (context.signal.aborted) return this.cancelledExecution();

    const id = randomUUID();
    return new Promise<ToolExecution<unknown>>((resolve) => {
      const abortListener = () => this.cancelCall(id, 'cancelled');
      const pending: ExecutePending = {
        kind: 'execute',
        limits: context.limits,
        resolve,
        signal: context.signal,
        abortListener,
        settledEarly: false,
        timer: setTimeout(() => this.cancelCall(id, 'timeout'), context.limits.timeoutMs),
      };
      this.pending.set(id, pending);
      context.signal.addEventListener('abort', abortListener, { once: true });
      try {
        this.worker.postMessage({
          type: 'execute',
          id,
          callId: context.toolCallId,
          toolName,
          input: normalized.value,
          limits: context.limits,
        });
      } catch (error) {
        this.removePending(id, pending);
        resolve(
          failed({
            category: 'tool_execution',
            code: 'EXTENSION_REQUEST_FAILED',
            message: 'The extension request could not be sent.',
            retryable: false,
            cause: error,
          }),
        );
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.isClosed) return;
    if (this.activeCallCount > 0) {
      throw new ExtensionWorkerError('EXTENSION_BUSY', 'Extension has active calls.');
    }
    this.shuttingDown = true;
    this.isClosed = true;
    const exited = new Promise<void>((resolve) => this.worker.once('exit', () => resolve()));
    try {
      this.worker.postMessage({ type: 'shutdown', id: randomUUID() });
    } catch {
      await this.worker.terminate();
      return;
    }
    await Promise.race([
      exited,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          void this.worker.terminate().then(() => resolve());
        }, this.shutdownTimeoutMs),
      ),
    ]);
  }

  private initialize(timeoutMs: number): Promise<void> {
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new ExtensionWorkerError(
          'WORKER_INITIALIZATION_FAILED',
          'Extension worker initialization timed out.',
        );
        this.pending.delete(id);
        this.fault(error.code, error.message, error);
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { kind: 'initialize', resolve, reject, timer });
      this.worker.postMessage({ type: 'initialize', id });
    });
  }

  private onMessage(message: unknown): void {
    if (!isRecord(message) || !isMessageId(message['id']) || typeof message['type'] !== 'string') {
      this.fault('WORKER_PROTOCOL_ERROR', 'Extension worker sent a malformed message.');
      return;
    }
    const pending = this.pending.get(message['id']);
    if (pending === undefined) {
      if (this.shuttingDown && message['type'] === 'ready') return;
      this.fault('WORKER_PROTOCOL_ERROR', 'Extension worker sent an unexpected response id.');
      return;
    }
    if (pending.kind === 'initialize') {
      clearTimeout(pending.timer);
      this.pending.delete(message['id']);
      if (message['type'] === 'ready' && Array.isArray(message['tools'])) {
        pending.resolve();
        return;
      }
      const error = new ExtensionWorkerError(
        message['type'] === 'failure' ? 'WORKER_INITIALIZATION_FAILED' : 'WORKER_PROTOCOL_ERROR',
        typeof message['message'] === 'string'
          ? message['message']
          : 'Extension worker initialization failed.',
      );
      pending.reject(error);
      this.fault(error.code, error.message, error);
      return;
    }

    if (pending.settledEarly) {
      this.removePending(message['id'], pending);
      return;
    }
    if (message['type'] === 'failure' && message['phase'] === 'execute') {
      this.removePending(message['id'], pending);
      pending.resolve(
        failed({
          category: 'tool_execution',
          code: 'EXTENSION_HANDLER_FAILED',
          message:
            typeof message['message'] === 'string'
              ? boundedText(message['message'], pending.limits.maxOutputChars).text
              : 'Extension handler failed.',
          retryable: false,
        }),
      );
      return;
    }
    if (message['type'] !== 'result') {
      this.fault('WORKER_PROTOCOL_ERROR', 'Extension worker returned an invalid response type.');
      return;
    }
    try {
      const execution = normalizeExecution(message['execution'], pending.limits.maxOutputChars);
      this.removePending(message['id'], pending);
      pending.resolve(execution);
    } catch (error) {
      this.fault(
        'WORKER_PROTOCOL_ERROR',
        'Extension worker returned an invalid ToolExecution.',
        error,
      );
    }
  }

  private cancelCall(id: string, reason: 'cancelled' | 'timeout'): void {
    const pending = this.pending.get(id);
    if (pending?.kind !== 'execute' || pending.settledEarly) return;
    pending.settledEarly = true;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener('abort', pending.abortListener);
    pending.resolve(reason === 'timeout' ? this.timeoutExecution() : this.cancelledExecution());
    try {
      this.worker.postMessage({ type: 'cancel', id: randomUUID(), targetId: id });
    } catch (error) {
      this.fault('WORKER_CRASHED', 'Extension cancellation could not be sent.', error);
      return;
    }
    pending.graceTimer = setTimeout(() => {
      this.fault(
        reason === 'timeout' ? 'WORKER_TIMEOUT' : 'WORKER_CRASHED',
        'Extension worker did not stop the cancelled call within the grace period.',
      );
    }, this.cancelGraceMs);
  }

  private removePending(id: string, pending: ExecutePending): void {
    clearTimeout(pending.timer);
    if (pending.graceTimer !== undefined) clearTimeout(pending.graceTimer);
    pending.signal.removeEventListener('abort', pending.abortListener);
    this.pending.delete(id);
  }

  private timeoutExecution(): ToolExecution<unknown> {
    return failed({
      category: 'tool_timeout',
      code: 'EXTENSION_CALL_TIMEOUT',
      message: 'The extension call exceeded its time limit.',
      retryable: false,
    });
  }

  private cancelledExecution(): ToolExecution<unknown> {
    return failed({
      category: 'cancelled',
      code: 'EXTENSION_CALL_CANCELLED',
      message: 'The extension call was cancelled.',
      retryable: false,
    });
  }

  private fault(code: ExtensionWorkerErrorCode, message: string, cause?: unknown): void {
    if (this.shuttingDown) return;
    if (this.isClosed && this.faultReported) return;
    this.isClosed = true;
    const safeMessage = boundedText(message, EXTENSION_LIMITS.quarantineReasonLength).text;
    if (!this.faultReported) {
      this.faultReported = true;
      void this.options.onFault?.({ extensionId: this.extensionId, code, message: safeMessage });
    }
    for (const [id, pending] of this.pending) {
      if (pending.kind === 'initialize') {
        clearTimeout(pending.timer);
        pending.reject(new ExtensionWorkerError(code, safeMessage, cause));
      } else {
        this.removePending(id, pending);
        if (!pending.settledEarly) {
          pending.resolve(
            failed({
              category: 'tool_execution',
              code,
              message: safeMessage,
              retryable: false,
              cause,
            }),
          );
        }
      }
      this.pending.delete(id);
    }
    void this.worker.terminate();
  }
}
