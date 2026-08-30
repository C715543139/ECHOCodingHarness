import type { SessionPhase } from '../../../contracts/web.js';

export const SESSION_PHASE_LABELS: Record<SessionPhase, string> = {
  idle: 'Idle',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  limited: 'Limited',
};
