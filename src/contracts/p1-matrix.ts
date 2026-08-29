export interface P1MatrixRow {
  readonly id: string;
  readonly area: 'config' | 'events' | 'application' | 'chat' | 'exit' | 'p0-guard';
  readonly requirement: string;
  readonly contractEvidence: string;
  readonly runtimeEvidence: string;
  readonly runtimeTask: 'P1-0' | 'P1-2A' | 'P1-2B' | 'P1-1A' | 'P1-1B' | 'P1-3';
}

export const P1_TEST_MATRIX: readonly P1MatrixRow[] = [
  {
    id: 'CFG-01',
    area: 'config',
    requirement: 'Persistent config path is only <artifact-root>/config/echo.config.json',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'pending:P1-2A',
    runtimeTask: 'P1-2A',
  },
  {
    id: 'CFG-02',
    area: 'config',
    requirement: 'artifact-root is resolved from the CLI module/executable, never process.cwd()',
    contractEvidence: 'docs/decisions/0002-p1-config-artifact-root.md',
    runtimeEvidence: 'pending:P1-2A',
    runtimeTask: 'P1-2A',
  },
  {
    id: 'CFG-03',
    area: 'config',
    requirement:
      'P1 config merge is only CLI explicit args over echo.config.json; built-in field defaults are not a source',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'pending:P1-2A',
    runtimeTask: 'P1-2A',
  },
  {
    id: 'CFG-04',
    area: 'config',
    requirement: 'Unknown keys, credentials, and embedded URL userinfo fail closed',
    contractEvidence: 'docs/decisions/0002-p1-config-artifact-root.md',
    runtimeEvidence: 'pending:P1-2A',
    runtimeTask: 'P1-2A',
  },
  {
    id: 'CFG-05',
    area: 'config',
    requirement: 'Manual catalog uniqueness and default-model membership; discover stores no list',
    contractEvidence: 'docs/decisions/0002-p1-config-artifact-root.md',
    runtimeEvidence: 'pending:P1-2A',
    runtimeTask: 'P1-2A',
  },
  {
    id: 'CFG-06',
    area: 'config',
    requirement: 'Missing config is exit code 2 and does not auto-create a real config file',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'pending:P1-2A',
    runtimeTask: 'P1-2A',
  },
  {
    id: 'EVT-01',
    area: 'events',
    requirement: 'Event schema version 2 adds session.resumed, model.changed, and safety.changed',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'tests/unit/application/echo-application-service.test.ts',
    runtimeTask: 'P1-1A',
  },
  {
    id: 'EVT-02',
    area: 'events',
    requirement:
      'Session Provider fields use ProviderIdentity with branded EndpointFingerprint, never a raw URL string',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'tests/unit/session/endpoint-fingerprint.test.ts',
    runtimeTask: 'P1-1A',
  },
  {
    id: 'APP-01',
    area: 'application',
    requirement:
      'run and chat share ApplicationService; respondToApproval binds turnId+toolCallId+approvalKey and returns accepted/duplicate/expired/not_pending',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'tests/unit/application/echo-application-service.test.ts',
    runtimeTask: 'P1-1A',
  },
  {
    id: 'APP-02',
    area: 'application',
    requirement:
      'SessionRepository.create accepts model and safetyMode so SessionSummary can be returned without extra reads',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'tests/unit/session/jsonl-session-repository.test.ts',
    runtimeTask: 'P1-1A',
  },
  {
    id: 'APP-03',
    area: 'application',
    requirement:
      'Model and safety resolve cli > session > config on resume, cli > config on new sessions; P1-0 freezes the table only',
    contractEvidence: 'docs/decisions/0003-p1-application-service-session.md',
    runtimeEvidence: 'pending:P1-1B',
    runtimeTask: 'P1-1B',
  },
  {
    id: 'CHAT-01',
    area: 'chat',
    requirement: 'Slash commands parse only typed idle input; paste never becomes a slash command',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'pending:P1-1B',
    runtimeTask: 'P1-1B',
  },
  {
    id: 'CHAT-02',
    area: 'chat',
    requirement: 'Bracketed paste is the frozen multi-line boundary; one paste is at most one Turn',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'pending:P1-1B',
    runtimeTask: 'P1-1B',
  },
  {
    id: 'EXIT-01',
    area: 'exit',
    requirement: 'P0 AgentResult exit mapping stays 0/1/3/4/5/6/130; config/usage failures stay 2',
    contractEvidence: 'tests/unit/contracts/p1-baseline.test.ts',
    runtimeEvidence: 'tests/integration/cli-run.test.ts',
    runtimeTask: 'P1-0',
  },
  {
    id: 'P0-01',
    area: 'p0-guard',
    requirement: 'Until P1-2A, loadConfig still honors cli > env > project > user > defaults',
    contractEvidence: 'tests/unit/contracts/doc-consistency.test.ts',
    runtimeEvidence: 'tests/unit/config/load-config.test.ts',
    runtimeTask: 'P1-0',
  },
] as const;
