import type { EchoError, ToolContext, ToolDefinition, ToolExecution } from '../contracts/index.js';

import { ExtensionLifecycleError, ExtensionStorageError, ExtensionWorkerError } from './errors.js';
import type {
  ExtensionCheckReport,
  ExtensionLifecycleManager,
  ExtensionListItem,
  ExtensionMutationResult,
} from './lifecycle-manager.js';

type LifecycleToolData =
  ExtensionCheckReport | ExtensionMutationResult | readonly ExtensionListItem[];

const EXTENSION_ID_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    extensionId: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 64 },
  },
  required: ['extensionId'],
} as const;

const EMPTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

function invalidInput(message: string): ToolExecution<LifecycleToolData> {
  return {
    status: 'failed',
    summary: message,
    error: {
      category: 'invalid_tool_input',
      code: 'INVALID_EXTENSION_ARGUMENTS',
      message,
      retryable: false,
    },
    truncated: false,
  };
}

function readObject(input: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Extension tool input must be an object.');
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Extension tool input contains an unknown field.');
  }
  return value;
}

function extensionIdInput(input: unknown): string {
  const value = readObject(input, ['extensionId']);
  if (typeof value['extensionId'] !== 'string') {
    throw new TypeError('extensionId must be a string.');
  }
  return value['extensionId'];
}

function initInput(input: unknown): {
  readonly extensionId: string;
  readonly toolNames: readonly string[];
} {
  const value = readObject(input, ['extensionId', 'toolNames']);
  if (
    typeof value['extensionId'] !== 'string' ||
    !Array.isArray(value['toolNames']) ||
    value['toolNames'].some((name) => typeof name !== 'string')
  ) {
    throw new TypeError('extensionId must be a string and toolNames must be a string array.');
  }
  return { extensionId: value['extensionId'], toolNames: value['toolNames'] as readonly string[] };
}

function mapError(error: unknown): EchoError {
  if (error instanceof ExtensionLifecycleError) {
    const code = error.code === 'ALREADY_EXISTS' ? 'EXTENSION_ALREADY_EXISTS' : error.code;
    return {
      category:
        error.code === 'EXTENSION_OPERATION_CANCELLED'
          ? 'cancelled'
          : error.code === 'EXTENSION_BUSY'
            ? 'tool_execution'
            : 'storage',
      code,
      message: error.message,
      retryable: error.code === 'EXTENSION_BUSY',
    };
  }
  if (error instanceof ExtensionStorageError) {
    return {
      category: 'storage',
      code: error.code,
      message: error.message,
      retryable: error.code === 'CATALOG_REVISION_CONFLICT',
    };
  }
  if (error instanceof ExtensionWorkerError) {
    return {
      category: error.code === 'WORKER_TIMEOUT' ? 'tool_timeout' : 'tool_execution',
      code: error.code,
      message: error.message,
      retryable: error.code === 'EXTENSION_BUSY',
    };
  }
  return {
    category: 'internal',
    code: 'EXTENSION_OPERATION_FAILED',
    message: 'The extension operation did not complete.',
    retryable: false,
  };
}

async function execute(
  operation: () => Promise<LifecycleToolData>,
  summary: (data: LifecycleToolData) => string,
): Promise<ToolExecution<LifecycleToolData>> {
  try {
    const data = await operation();
    return { status: 'completed', summary: summary(data), data, truncated: false };
  } catch (error) {
    if (error instanceof TypeError) return invalidInput(error.message);
    const mapped = mapError(error);
    return {
      status: 'failed',
      summary: mapped.message,
      error: mapped,
      truncated: false,
    };
  }
}

function contextOperation<T>(
  context: ToolContext,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return operation(context.signal);
}

export function createExtensionLifecycleTools(
  manager: ExtensionLifecycleManager,
): readonly ToolDefinition<unknown, LifecycleToolData>[] {
  return [
    {
      name: 'extension_init',
      description:
        'Create a non-overwriting workspace extension staging template and authoring guide. Full Access only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          extensionId: EXTENSION_ID_SCHEMA.properties.extensionId,
          toolNames: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            uniqueItems: true,
            items: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$', maxLength: 64 },
          },
        },
        required: ['extensionId', 'toolNames'],
      },
      execute: (input, context) => {
        let parsed: ReturnType<typeof initInput>;
        try {
          parsed = initInput(input);
        } catch (error) {
          return Promise.resolve(
            invalidInput(error instanceof Error ? error.message : 'Invalid extension_init input.'),
          );
        }
        return execute(
          () => manager.init(parsed.extensionId, parsed.toolNames, context.signal),
          () => `Created staging template for ${parsed.extensionId}.`,
        );
      },
    },
    {
      name: 'extension_check',
      description:
        'Validate staged extension content, names, Worker initialization, handler correspondence, and self-test without installing it.',
      inputSchema: EXTENSION_ID_SCHEMA,
      execute: (input, context) => {
        let extensionId: string;
        try {
          extensionId = extensionIdInput(input);
        } catch (error) {
          return Promise.resolve(
            invalidInput(error instanceof Error ? error.message : 'Invalid extension_check input.'),
          );
        }
        return execute(
          () => contextOperation(context, (signal) => manager.check(extensionId, signal)),
          (data) => {
            const report = data as ExtensionCheckReport;
            return `Extension check ${report.status}: ${String(report.passedChecks)} passed, ${String(report.failedChecks)} failed.`;
          },
        );
      },
    },
    {
      name: 'extension_install',
      description:
        'Recheck, content-hash, atomically install, enable, and hot-load a staged workspace extension.',
      inputSchema: EXTENSION_ID_SCHEMA,
      execute: (input, context) =>
        lifecycleMutation(input, context, (id, signal) => manager.install(id, signal), 'installed'),
    },
    {
      name: 'extension_list',
      description:
        'List the current workspace extension Catalog and process-local loaded state. Does not scan other workspaces.',
      inputSchema: EMPTY_SCHEMA,
      execute: (input, context) => {
        try {
          readObject(input, []);
        } catch (error) {
          return Promise.resolve(
            invalidInput(error instanceof Error ? error.message : 'Invalid extension_list input.'),
          );
        }
        return execute(
          () => manager.list(context.signal),
          (data) =>
            `Listed ${String((data as readonly ExtensionListItem[]).length)} workspace extensions.`,
        );
      },
    },
    {
      name: 'extension_enable',
      description: 'Revalidate and enable an installed workspace extension.',
      inputSchema: EXTENSION_ID_SCHEMA,
      execute: (input, context) =>
        lifecycleMutation(input, context, (id, signal) => manager.enable(id, signal), 'enabled'),
    },
    {
      name: 'extension_disable',
      description:
        'Disable an installed workspace extension and unload all of its tools. Active calls fail with EXTENSION_BUSY.',
      inputSchema: EXTENSION_ID_SCHEMA,
      execute: (input, context) =>
        lifecycleMutation(input, context, (id, signal) => manager.disable(id, signal), 'disabled'),
    },
    {
      name: 'extension_uninstall',
      description:
        'Deactivate and remove an entire workspace extension, its installed versions, and staging content.',
      inputSchema: EXTENSION_ID_SCHEMA,
      execute: (input, context) =>
        lifecycleMutation(
          input,
          context,
          (id, signal) => manager.uninstall(id, signal),
          'uninstalled',
        ),
    },
  ];
}

async function lifecycleMutation(
  input: unknown,
  _context: ToolContext,
  operation: (extensionId: string, signal: AbortSignal) => Promise<ExtensionMutationResult>,
  verb: string,
): Promise<ToolExecution<LifecycleToolData>> {
  let extensionId: string;
  try {
    extensionId = extensionIdInput(input);
  } catch (error) {
    return invalidInput(error instanceof Error ? error.message : 'Invalid extension input.');
  }
  return execute(
    () => operation(extensionId, _context.signal),
    (data) => {
      const result = data as ExtensionMutationResult;
      return result.cleanupPending
        ? `Extension ${extensionId} was deactivated, but cleanup remains pending.`
        : `Extension ${extensionId} ${verb}${result.changed ? '' : ' (no change)'}.`;
    },
  );
}
