import { createHash } from 'node:crypto';
import { win32 as path } from 'node:path';

import type {
  PolicyDecision,
  PolicyRequest,
  SafetyMode,
  SafetyPolicy,
} from '../contracts/index.js';

export const DEFAULT_SAFETY_MODE: SafetyMode = 'balanced';

const READ_FILE_TOOLS = new Set(['list_files', 'read_file', 'search_text']);
const WRITE_FILE_TOOLS = new Set(['apply_patch', 'write_file']);
const PATH_KEYS = new Set(['directory', 'directories', 'file', 'files', 'path', 'paths', 'target']);

type RiskClassification =
  | Readonly<{ kind: 'hard_deny'; reason: string }>
  | Readonly<{ kind: 'ask'; reason: string }>
  | Readonly<{ kind: 'read'; reason: string }>
  | Readonly<{ kind: 'validation'; reason: string }>
  | Readonly<{ kind: 'local_write'; reason: string }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function approvalKey(toolName: string, normalizedInput: unknown): string {
  const canonical = JSON.stringify(canonicalize(normalizedInput));
  const digest = createHash('sha256')
    .update(`${toolName}\0${canonical}`)
    .digest('hex')
    .slice(0, 24);
  return `approval:${toolName}:${digest}`;
}

function askOrApproved(request: PolicyRequest, reason: string): PolicyDecision {
  const key = approvalKey(request.toolName, request.normalizedInput);
  if (request.sessionApprovals.has(key)) {
    return { action: 'allow', reason: `Approved for this equivalent session operation: ${reason}` };
  }
  return { action: 'ask', reason, approvalKey: key };
}

function normalizedRoot(workspaceRoot: string): string {
  return path
    .resolve(workspaceRoot)
    .replace(/[\\/]+$/u, '')
    .toLocaleLowerCase('en-US');
}

function isInsideWorkspace(candidate: string, workspaceRoot: string): boolean {
  const root = normalizedRoot(workspaceRoot);
  const resolved = path.resolve(workspaceRoot, candidate).toLocaleLowerCase('en-US');
  return resolved === root || resolved.startsWith(`${root}\\`);
}

function collectDeclaredPaths(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const paths: string[] = [];
  for (const [key, candidate] of Object.entries(value)) {
    if (!PATH_KEYS.has(key.toLocaleLowerCase('en-US'))) continue;
    if (typeof candidate === 'string') paths.push(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) if (typeof item === 'string') paths.push(item);
    }
  }
  return paths;
}

function declaredPathViolation(
  normalizedInput: unknown,
  workspaceRoot: string,
  denyGitWrites: boolean,
): string | undefined {
  for (const candidate of collectDeclaredPaths(normalizedInput)) {
    if (/^(?:\\\\[?.]\\|\\\\)/u.test(candidate)) {
      return 'UNC and device paths are outside the supported workspace boundary.';
    }
    if (!isInsideWorkspace(candidate, workspaceRoot)) {
      return 'The normalized target escapes the fixed workspace root.';
    }
    if (denyGitWrites && /(?:^|[\\/])\.git(?:[\\/]|$)/iu.test(candidate)) {
      return 'Writing Git internal data is forbidden.';
    }
  }
  return undefined;
}

function extractCommandPaths(command: string): readonly string[] {
  const candidates: string[] = [];
  for (const match of command.matchAll(/["']([A-Za-z]:[^"']+)["']/gu)) {
    if (match[1] !== undefined) candidates.push(match[1]);
  }
  for (const match of command.matchAll(/(?:^|[\s(=,])((?:[A-Za-z]:|\\\\)[^\s;|,)]+)/gu)) {
    if (match[1] !== undefined) candidates.push(match[1].replace(/["']$/u, ''));
  }
  for (const match of command.matchAll(/(?:^|[\s"'(])((?:\.\.[\\/])+[^\s;|,)"']*)/gu)) {
    if (match[1] !== undefined) candidates.push(match[1]);
  }
  return candidates;
}

function commandBoundaryViolation(command: string, workspaceRoot: string): string | undefined {
  if (/\\\\[?.]\\/u.test(command)) {
    return 'PowerShell device paths are forbidden.';
  }
  if (
    /\$\{?env:[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%/iu.test(command) ||
    /\$(?:HOME|PWD|PSScriptRoot)\b|\$\{(?:HOME|PWD|PSScriptRoot)\}/iu.test(command) ||
    /(?:^|\s)Env:[A-Za-z_*][A-Za-z0-9_*]*/iu.test(command) ||
    /\[Environment\]::GetFolderPath\s*\(/iu.test(command) ||
    /(?:^|[\s"'(])~(?:[\\/]|\s|$)/u.test(command)
  ) {
    return 'Dynamic environment and home paths cannot prove workspace containment.';
  }
  if (/(?:^|[\\/])[^\\/\s]*~\d+(?:[\\/]|$)/u.test(command)) {
    return 'DOS short-name paths cannot prove workspace containment.';
  }
  for (const candidate of extractCommandPaths(command)) {
    if (/^[A-Za-z]:[^\\/]/u.test(candidate)) {
      return 'Drive-relative paths cannot prove workspace containment.';
    }
    if (candidate.startsWith('\\\\') || !isInsideWorkspace(candidate, workspaceRoot)) {
      return 'The command references a path outside the fixed workspace root.';
    }
  }
  return undefined;
}

const DELETE_COMMAND_PATTERN = /\b(?:Remove-Item|ri|rm|del|erase|rmdir|rd)\b/iu;
const FILESYSTEM_WRITE_PATTERN =
  /(?:^|[;&|])\s*(?:Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Rename-Item|Out-File|Tee-Object|Export-Clixml|Export-Csv|sc|ac|ni|cp|copy|cpi|mv|move|mi|ren|rni|tee|Remove-Item|ri|rm|del|erase|rmdir|rd)\b/iu;

function isBroadDelete(command: string, workspaceRoot: string): boolean {
  if (!DELETE_COMMAND_PATTERN.test(command)) return false;
  const root = normalizedRoot(workspaceRoot);
  const deletesWorkspaceRoot = extractCommandPaths(command).some(
    (candidate) => path.resolve(workspaceRoot, candidate).toLocaleLowerCase('en-US') === root,
  );
  return (
    deletesWorkspaceRoot ||
    /(?:^|[\s"'])(?:\.(?:[\\/]\*?)?|\*|[A-Za-z]:[\\/]|[\\/])(?:[\s"']|$)/u.test(command) ||
    /\$(?:PWD)\b|\b(?:Get-Location|gl|pwd)\b|\bResolve-Path\s+\.(?:\s|\)|$)/iu.test(command)
  );
}

function classifyCommand(command: string, workspaceRoot: string): RiskClassification {
  const boundaryViolation = commandBoundaryViolation(command, workspaceRoot);
  if (boundaryViolation !== undefined) return { kind: 'hard_deny', reason: boundaryViolation };

  if (
    /(?:^|[\s"'(\\/])\.git(?=[\\/\s"')]|$)/iu.test(command) &&
    (FILESYSTEM_WRITE_PATTERN.test(command) || /(?:^|[^>])>(?:>|[^=])/u.test(command))
  ) {
    return {
      kind: 'hard_deny',
      reason: 'Direct command writes to Git internal data are forbidden.',
    };
  }

  if (
    /(?:\$\{?env:|%)(?:ECHO_API_KEY|GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|OPENAI_API_KEY|AZURE_[A-Z_]*(?:KEY|TOKEN)|AWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN)|GOOGLE_APPLICATION_CREDENTIALS)(?:\}?|%)/iu.test(
      command,
    ) ||
    /(?:Get-ChildItem|Get-Item|gci|gi|dir)\s+(?:-Path\s+)?Env:\s*(?:$|[*])/iu.test(command) ||
    /GetEnvironmentVariables\s*\(/iu.test(command) ||
    /(?:^|[\\/])(?:\.ssh|\.aws|\.azure)(?:[\\/]|$)/iu.test(command)
  ) {
    return { kind: 'hard_deny', reason: 'Credential access or environment export is forbidden.' };
  }

  if (
    /\b(?:Start-Process\b[\s\S]*-Verb\s+RunAs|runas(?:\.exe)?\b|Set-ExecutionPolicy\b|Set-MpPreference\b|sc(?:\.exe)?\s+(?:config|delete)|net\s+user\b[\s\S]*\/add)\b/iu.test(
      command,
    )
  ) {
    return {
      kind: 'hard_deny',
      reason: 'Privilege escalation or system security changes are forbidden.',
    };
  }

  if (
    /(?:-|\/)(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\b|\b(?:Invoke-Expression|iex)\b/iu.test(
      command,
    ) ||
    /\b(?:Format-Volume|Clear-Disk|Initialize-Disk|diskpart)\b/iu.test(command) ||
    /\b(?:Stop-Computer|Restart-Computer|shutdown(?:\.exe)?|bcdedit|takeown|vssadmin\s+delete|wbadmin\s+delete)\b/iu.test(
      command,
    ) ||
    /\breg(?:\.exe)?\s+delete\s+(?:HKLM|HKEY_LOCAL_MACHINE|HKCU|HKEY_CURRENT_USER)\\/iu.test(
      command,
    ) ||
    /\bgit\s+(?:reset\s+--hard|clean\s+[^\r\n]*-[^\s]*f|push\s+[^\r\n]*--force)\b/iu.test(
      command,
    ) ||
    isBroadDelete(command, workspaceRoot)
  ) {
    return {
      kind: 'hard_deny',
      reason: 'Encoded execution or broad destructive effects are forbidden.',
    };
  }

  if (
    /\b(?:pnpm|npm|yarn)\s+(?:add|install|remove|uninstall|update|upgrade)\b|\b(?:winget|choco|scoop)\s+(?:install|uninstall|upgrade)\b/iu.test(
      command,
    )
  ) {
    return { kind: 'ask', reason: 'Dependency or software changes require approval.' };
  }
  if (
    /\bgit\s+(?:add|commit|push|pull|fetch|clone|checkout|switch|merge|rebase|reset|clean|tag|stash|restore|rm|mv)\b|\bgit\s+branch\b[\s\S]*(?:-[dDmM]\b|--delete\b)/iu.test(
      command,
    )
  ) {
    return {
      kind: 'ask',
      reason: 'Git writes, history changes, or remote operations require approval.',
    };
  }
  if (
    /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget|Test-NetConnection|ssh|scp|ftp|Start-BitsTransfer)\b|https?:\/\//iu.test(
      command,
    )
  ) {
    return { kind: 'ask', reason: 'External network access requires approval.' };
  }
  if (DELETE_COMMAND_PATTERN.test(command)) {
    return { kind: 'ask', reason: 'Deletion requires approval.' };
  }
  if (
    /(?:^|[\s;&|])(?:&\s*)?\.\.?[\\/][^\s]+\.(?:ps1|cmd|bat)\b|\bpowershell(?:\.exe)?\b[\s\S]*\s-File\b|\b(?:node|python|py)\s+[^\s-][^\s]*\.(?:js|mjs|cjs|py)\b/iu.test(
      command,
    )
  ) {
    return {
      kind: 'ask',
      reason: 'Executing an unclassified repository script requires approval.',
    };
  }
  if (/[;&|]|(?:^|[^>])>(?:>|[^=])/u.test(command)) {
    return {
      kind: 'ask',
      reason: 'Compound commands, pipelines, and redirection require approval.',
    };
  }
  if (
    /^\s*(?:pnpm\s+(?:test|lint|typecheck|check|build|smoke)|npm\s+(?:test|run\s+(?:test|lint|typecheck|check|build)))(?:\s|$)/iu.test(
      command,
    )
  ) {
    return { kind: 'validation', reason: 'Known project validation command.' };
  }
  if (
    /^\s*git\s+(?:status|diff|log|show|rev-parse)(?:\s|$)/iu.test(command) ||
    /^\s*git\s+branch(?:\s+(?:--show-current|--list|-a|-r|-v|-vv))?\s*$/iu.test(command) ||
    /^\s*(?:Get-ChildItem|Get-Content|Select-String|Test-Path|Get-Location|Write-Output)\b/iu.test(
      command,
    )
  ) {
    return { kind: 'read', reason: 'Known read-only diagnostic command.' };
  }
  if (
    /^\s*(?:Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Rename-Item)\b/iu.test(command)
  ) {
    return { kind: 'local_write', reason: 'Explicitly scoped workspace command write.' };
  }
  return { kind: 'ask', reason: 'The command effect is not explicitly classified as safe.' };
}

function modeDecision(
  request: PolicyRequest,
  classification: Exclude<RiskClassification, { kind: 'hard_deny' }>,
): PolicyDecision {
  if (classification.kind === 'ask') return askOrApproved(request, classification.reason);
  if (classification.kind === 'read') return { action: 'allow', reason: classification.reason };
  if (classification.kind === 'validation') {
    return request.mode === 'safe'
      ? askOrApproved(request, classification.reason)
      : { action: 'allow', reason: classification.reason };
  }
  return request.mode === 'auto'
    ? { action: 'allow', reason: classification.reason }
    : askOrApproved(request, classification.reason);
}

export class CentralSafetyPolicy implements SafetyPolicy {
  public evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    const denyGitWrites = WRITE_FILE_TOOLS.has(request.toolName);
    const pathViolation = declaredPathViolation(
      request.normalizedInput,
      request.workspaceRoot,
      denyGitWrites,
    );
    if (pathViolation !== undefined) {
      return Promise.resolve({ action: 'deny', reason: pathViolation, hard: true });
    }

    if (READ_FILE_TOOLS.has(request.toolName)) {
      return Promise.resolve({ action: 'allow', reason: 'Workspace-scoped read operation.' });
    }
    if (WRITE_FILE_TOOLS.has(request.toolName)) {
      return Promise.resolve(
        request.mode === 'safe'
          ? askOrApproved(request, 'Workspace file writes require approval in safe mode.')
          : { action: 'allow', reason: 'Workspace-scoped file write allowed by this mode.' },
      );
    }
    if (request.toolName !== 'run_command') {
      return Promise.resolve({
        action: 'deny',
        reason: 'Unrecognized tools cannot bypass the centralized safety policy.',
        hard: true,
      });
    }
    if (!isRecord(request.normalizedInput) || typeof request.normalizedInput.command !== 'string') {
      return Promise.resolve({
        action: 'deny',
        reason: 'run_command requires a normalized command string.',
        hard: false,
      });
    }

    const classification = classifyCommand(request.normalizedInput.command, request.workspaceRoot);
    return Promise.resolve(
      classification.kind === 'hard_deny'
        ? { action: 'deny', reason: classification.reason, hard: true }
        : modeDecision(request, classification),
    );
  }
}
