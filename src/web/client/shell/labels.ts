import type { ChatToolSummaryStatus, SessionPhase } from '../../../contracts/web.js';

export const SESSION_PHASE_LABELS: Record<SessionPhase, string> = {
  idle: 'Idle',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  limited: 'Limited',
};

export const TOOL_SUMMARY_LABELS: Record<ChatToolSummaryStatus, string> = {
  running: 'running',
  awaiting_approval: 'awaiting_approval',
  completed: 'completed',
  failed: 'failed',
  denied: 'denied',
  cancelled: 'cancelled',
};

export const APPROVAL_CHOICE_LABELS = {
  deny: '拒绝',
  allow_once: '仅本次允许',
  allow_session: '本 Session 允许',
} as const;
