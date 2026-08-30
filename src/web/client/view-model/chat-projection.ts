import type { ChatTurnDto } from '../../../contracts/web.js';

export function upsertChatTurn(
  turns: readonly ChatTurnDto[],
  next: ChatTurnDto,
): readonly ChatTurnDto[] {
  const index = turns.findIndex((turn) => turn.turnId === next.turnId);
  if (index === -1) {
    return [...turns, next];
  }
  return turns.map((turn, current) => (current === index ? next : turn));
}

export function projectChatTurns(turns: readonly ChatTurnDto[]): readonly ChatTurnDto[] {
  return turns.map((turn) => ({
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    userText: turn.userText,
    responses: turn.responses.map((response) => ({
      step: response.step,
      text: response.text,
      partial: response.partial,
    })),
    toolSummaries: turn.toolSummaries.map((summary) => ({
      toolCallId: summary.toolCallId,
      name: summary.name,
      status: summary.status,
      ...(summary.resultSummary === undefined ? {} : { resultSummary: summary.resultSummary }),
    })),
    status: turn.status,
    ...(turn.stopReason === undefined ? {} : { stopReason: turn.stopReason }),
  }));
}

export function hasStreamingResponse(turn: ChatTurnDto): boolean {
  return turn.responses.some((response) => response.partial);
}
