import { describe, expect, it } from 'vitest';

import {
  renderChatBanner,
  renderChatEcho,
  renderIdlePrompt,
  renderSessionStatus,
  renderSlashFeedback,
  renderYouPrompt,
  workspaceDisplayName,
} from '../../../src/cli/chat-view.js';
import type { RenderCapabilities } from '../../../src/contracts/index.js';

const plain: RenderCapabilities = {
  interactive: true,
  color: false,
  unicode: false,
  verbose: false,
  columns: 80,
};

function join(chunks: readonly { text: string }[]): string {
  return chunks.map((chunk) => chunk.text).join('');
}

describe('Chat presentation', () => {
  it('renders a startup banner without personal paths or secrets', () => {
    const text = join(
      renderChatBanner(
        {
          workspaceName: 'ECHOCodingHarness',
          sessionShortId: 'a13f09c2',
          providerLabel: 'OpenAI-compatible',
          model: 'deepseek-chat',
          safetyMode: 'balanced',
          resumed: false,
        },
        plain,
      ),
    );
    expect(text).toContain('ECHO Harness · chat');
    expect(text).toContain('WORKSPACE  | ECHOCodingHarness');
    expect(text).toContain('SESSION    | a13f09c2');
    expect(text).toContain('MODEL      | deepseek-chat');
    expect(text).toContain('Type /help for commands');
    expect(text).not.toContain('C:\\Users');
  });

  it('renders a resumed banner, status strip, and YOU prompt', () => {
    expect(
      join(
        renderChatBanner(
          {
            workspaceName: 'ECHOCodingHarness',
            sessionShortId: 'a13f09c2',
            providerLabel: 'OpenAI-compatible',
            model: 'deepseek-chat',
            safetyMode: 'balanced',
            resumed: true,
          },
          plain,
        ),
      ),
    ).toContain('ECHO Harness · resumed session');

    const idle = join(
      renderIdlePrompt(
        {
          workspaceName: 'ECHOCodingHarness',
          model: 'deepseek-chat',
          safetyMode: 'balanced',
          contextPercent: 78,
        },
        plain,
      ),
    );
    expect(idle).toContain('ECHOCodingHarness | deepseek-chat | balanced | context 78%');
    expect(idle).toContain('YOU > ');
    expect(renderYouPrompt({ ...plain, unicode: true }).text).toBe('YOU › ');
  });

  it('warns once context reaches 90 percent and keeps slash feedback off the Step timeline', () => {
    const strip = join(
      renderIdlePrompt(
        {
          workspaceName: 'demo',
          model: 'demo-model',
          safetyMode: 'auto',
          contextPercent: 91,
        },
        { ...plain, color: true },
      ),
    );
    expect(strip).toContain('context 91%');
    expect(strip).toContain('\u001B[');

    const model = join(renderSlashFeedback({ kind: 'model', value: 'deepseek-reasoner' }, plain));
    expect(model).toBe('MODEL      | deepseek-reasoner\n           | Applies to the next turn.\n');
    expect(model).not.toContain('Step');
    expect(join(renderSlashFeedback({ kind: 'safety', value: 'auto' }, plain))).toContain(
      'SAFETY     | auto',
    );
    expect(
      join(
        renderSlashFeedback(
          { kind: 'info', label: 'MODEL', lines: ['fake-model', 'Candidates: fake-model'] },
          plain,
        ),
      ),
    ).toContain('Candidates: fake-model');
    expect(
      join(renderSlashFeedback({ kind: 'error', label: 'MODEL', message: 'unknown model' }, plain)),
    ).toContain('unknown model');
  });

  it('renders /status details with setting sources and key presence only', () => {
    const text = join(
      renderSessionStatus(
        {
          workspaceName: 'ECHOCodingHarness',
          sessionShortId: 'a13f09c2',
          providerLabel: 'OpenAI-compatible',
          model: 'deepseek-reasoner',
          modelSource: 'session',
          safetyMode: 'auto',
          safetySource: 'session',
          turns: 6,
          contextUsed: 18_400,
          contextBudget: 28_000,
          lastTurn: { status: 'completed', steps: 5, tools: 7 },
          lastCheck: { command: 'pnpm test', exitCode: 0 },
          apiKey: 'configured',
        },
        plain,
      ),
    );
    expect(text).toContain('-- Session status ');
    expect(text).toContain('MODEL      | deepseek-reasoner | session');
    expect(text).toContain('SAFETY     | auto | session');
    expect(text).toContain('API KEY    | configured');
    expect(text).toContain('LAST CHECK | pnpm test | exit 0');
    expect(text).not.toContain('sk-');
  });

  it('labels Chat replies as ECHO and derives a safe workspace name', () => {
    expect(join(renderChatEcho('已修复参数解析问题。', plain))).toBe(
      'ECHO       | 已修复参数解析问题。\n',
    );
    expect(workspaceDisplayName('F:\\Repo\\ECHOCodingHarness')).toBe('ECHOCodingHarness');
  });
});
