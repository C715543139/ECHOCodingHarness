import type { SafetyMode } from './safety.js';

/** P3 safety-mode contract. P3-A1 promotes this union into the runtime boundary. */
export const P3_SAFETY_MODES = ['safe', 'balanced', 'auto', 'full-access'] as const;
export type P3SafetyMode = (typeof P3_SAFETY_MODES)[number];
export type EstablishedSafetyMode = SafetyMode;

export const FULL_ACCESS_CONFIRMATION_SOURCES = [
  'cli-interactive',
  'cli-flag',
  'web-dialog',
] as const;
export type FullAccessConfirmationSource = (typeof FULL_ACCESS_CONFIRMATION_SOURCES)[number];

export interface FullAccessConfirmation {
  readonly acceptedRisk: true;
  readonly source: FullAccessConfirmationSource;
}

export const P3_EXTENSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const P3_EXTENSION_CATALOG_SCHEMA_VERSION = 1 as const;
export const P3_EXTENSION_STATES = ['enabled', 'disabled', 'quarantined'] as const;
export type ExtensionState = (typeof P3_EXTENSION_STATES)[number];

export const P3_EXTENSION_LIFECYCLE_TOOLS = [
  'extension_init',
  'extension_check',
  'extension_install',
  'extension_list',
  'extension_enable',
  'extension_disable',
  'extension_uninstall',
] as const;
export type ExtensionLifecycleToolName = (typeof P3_EXTENSION_LIFECYCLE_TOOLS)[number];

export interface ExtensionToolManifest {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ExtensionManifest {
  readonly schemaVersion: typeof P3_EXTENSION_MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  readonly selfTest: string;
  readonly tools: readonly ExtensionToolManifest[];
}

export interface ExtensionCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly contentHash: string;
  readonly state: ExtensionState;
  readonly tools: readonly string[];
  readonly installedAt: string;
  readonly quarantineReason?: string;
  readonly cleanupPending?: boolean;
}

export interface ExtensionCatalog {
  readonly schemaVersion: typeof P3_EXTENSION_CATALOG_SCHEMA_VERSION;
  readonly revision: number;
  readonly extensions: readonly ExtensionCatalogEntry[];
}

export const P3_EXTENSION_WORKER_REQUESTS = [
  'initialize',
  'execute',
  'cancel',
  'shutdown',
] as const;
export const P3_EXTENSION_WORKER_RESPONSES = [
  'ready',
  'result',
  'failure',
  'protocol_error',
] as const;

export type P3MatrixArea =
  'full-access' | 'storage' | 'worker' | 'lifecycle' | 'web' | 'integration' | 'demo' | 'guard';

export type P3RuntimeTask =
  'P3-A1' | 'P3-A2' | 'P3-B1' | 'P3-B2' | 'P3-B3' | 'P3-C1' | 'P3-C2' | 'P3-C3';

export interface P3MatrixRow {
  readonly id: string;
  readonly area: P3MatrixArea;
  readonly requirement: string;
  readonly contractEvidence: string;
  readonly runtimeEvidence: string;
  readonly runtimeTask: P3RuntimeTask;
}

export const P3_TEST_MATRIX: readonly P3MatrixRow[] = [
  {
    id: 'FULL-01',
    area: 'full-access',
    requirement: 'Full Access requires an explicit human confirmation bound to the target session',
    contractEvidence: 'docs/decisions/0010-full-access-mode.md',
    runtimeEvidence: 'tests/unit/application/full-access.test.ts',
    runtimeTask: 'P3-A1',
  },
  {
    id: 'FULL-02',
    area: 'full-access',
    requirement:
      'Confirmed Full Access bypasses per-operation policy approval while preserving validation, limits, cancellation, events, redaction, and cleanup',
    contractEvidence: 'docs/decisions/0010-full-access-mode.md',
    runtimeEvidence: 'tests/unit/security/command-policy.test.ts',
    runtimeTask: 'P3-A1',
  },
  {
    id: 'FULL-03',
    area: 'guard',
    requirement: 'Safe, balanced, and auto behavior remains unchanged',
    contractEvidence: 'docs/security.md',
    runtimeEvidence: 'tests/unit/application/full-access.test.ts',
    runtimeTask: 'P3-A1',
  },
  {
    id: 'EXT-01',
    area: 'storage',
    requirement:
      'Extensions are persisted only under the current workspace .echo directory and never shared across workspaces',
    contractEvidence: 'docs/decisions/0011-workspace-extensions.md',
    runtimeEvidence: 'tests/unit/extensions/workspace-isolation.test.ts',
    runtimeTask: 'P3-A2',
  },
  {
    id: 'EXT-02',
    area: 'storage',
    requirement:
      'Manifest, entry paths, tool names, content hashes, and atomic catalog writes fail closed',
    contractEvidence: 'docs/decisions/0011-workspace-extensions.md',
    runtimeEvidence: 'tests/unit/extensions/catalog.test.ts',
    runtimeTask: 'P3-A2',
  },
  {
    id: 'WRK-01',
    area: 'worker',
    requirement:
      'Extension workers have bounded protocol, output, timeout, cancellation, credential inheritance, and shutdown behavior',
    contractEvidence: 'docs/decisions/0011-workspace-extensions.md',
    runtimeEvidence: 'pending:P3-B1',
    runtimeTask: 'P3-B1',
  },
  {
    id: 'WRK-02',
    area: 'worker',
    requirement:
      'New tools become model-visible only at the next model-request boundary and registry collisions fail closed',
    contractEvidence: 'docs/plans/p3-extensions.md',
    runtimeEvidence: 'pending:P3-B1',
    runtimeTask: 'P3-B1',
  },
  {
    id: 'LIFE-01',
    area: 'lifecycle',
    requirement: 'The seven lifecycle tools implement the frozen state transitions and idempotency',
    contractEvidence: 'docs/plans/p3-extensions.md',
    runtimeEvidence: 'pending:P3-B2',
    runtimeTask: 'P3-B2',
  },
  {
    id: 'LIFE-02',
    area: 'lifecycle',
    requirement:
      'Busy extensions are not disabled or uninstalled; incomplete physical deletion is reported as cleanup pending',
    contractEvidence: 'docs/decisions/0011-workspace-extensions.md',
    runtimeEvidence: 'pending:P3-B2',
    runtimeTask: 'P3-B2',
  },
  {
    id: 'WEB-01',
    area: 'web',
    requirement:
      'Web confirmation, persistent Full Access warning, and human extension management use authenticated bounded DTOs',
    contractEvidence: 'docs/web-api.md, docs/web-ui.md',
    runtimeEvidence: 'pending:P3-B3',
    runtimeTask: 'P3-B3',
  },
  {
    id: 'INT-01',
    area: 'integration',
    requirement:
      'Enabled extensions are reusable across sessions and process restarts in one workspace but unavailable in another workspace',
    contractEvidence: 'docs/decisions/0011-workspace-extensions.md',
    runtimeEvidence: 'pending:P3-C1',
    runtimeTask: 'P3-C1',
  },
  {
    id: 'INT-02',
    area: 'integration',
    requirement:
      'Leaving Full Access unregisters dynamic tools at the next model-request boundary without deleting installed files',
    contractEvidence: 'docs/decisions/0010-full-access-mode.md',
    runtimeEvidence: 'pending:P3-C1',
    runtimeTask: 'P3-C1',
  },
  {
    id: 'DEMO-01',
    area: 'demo',
    requirement:
      'The synthetic PDF demo proves failing baseline, protected-input hashes, successful repair, independent recheck, and same-workspace reuse',
    contractEvidence: 'docs/plans/p3-extensions.md',
    runtimeEvidence: 'pending:P3-C2',
    runtimeTask: 'P3-C2',
  },
  {
    id: 'DONE-01',
    area: 'guard',
    requirement:
      'P3 closes only after full quality, privacy, artifact, real-provider, documentation, and two-minute demonstration acceptance',
    contractEvidence: 'docs/plans/p3-acceptance-matrix.md',
    runtimeEvidence: 'pending:P3-C3',
    runtimeTask: 'P3-C3',
  },
] as const;
