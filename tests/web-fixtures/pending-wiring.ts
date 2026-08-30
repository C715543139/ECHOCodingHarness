export interface PendingWiringItem {
  readonly id: string;
  readonly matrixId: string;
  readonly owner: 'p2-b1' | 'p2-b2' | 'p2-b3' | 'p2-c1';
  readonly reason: string;
}

/**
 * Honest Phase A gaps. B4 fixtures exercise current surfaces and record these
 * items instead of forging Session/Turn/SSE/approval-button success.
 */
export const P2_B4_PENDING_WIRING = [
  {
    id: 'session-turn-api',
    matrixId: 'P2-1-08',
    owner: 'p2-b1',
    reason: 'POST /api/v1/sessions and Turn/approval routes are not registered in Phase A.',
  },
  {
    id: 'sse-resync',
    matrixId: 'P2-1-11',
    owner: 'p2-b1',
    reason: 'Live SSE seq catch-up and resync_required are not projected by the HTTP adapter yet.',
  },
  {
    id: 'chat-approval-actions',
    matrixId: 'P2-2-07',
    owner: 'p2-b2',
    reason: 'ChatView does not render deny / allow_once / allow_session controls.',
  },
  {
    id: 'http-console-transport',
    matrixId: 'P2-2-01',
    owner: 'p2-c1',
    reason: 'Packaged App still mounts Fake transport; C1 wires the live adapter.',
  },
  {
    id: 'trace-http-pagination',
    matrixId: 'P2-3-09',
    owner: 'p2-c1',
    reason: 'B3 virtualizes the bounded page; C1 wires HTTP pagination and older-page navigation.',
  },
  {
    id: 'quality-script-ci',
    matrixId: 'P2-4-09',
    owner: 'p2-c1',
    reason:
      'package.json scripts and CI must not change in B4; C1 wires e2e/isolated smoke/scan and must upload only artifacts that pass scan-web-artifacts (unscannable zip and oversized files fail closed).',
  },
] as const satisfies readonly PendingWiringItem[];
