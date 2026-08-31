export function summarizeScores(scores) {
  const total = scores.reduce((sum, score) => sum + score, 0);
  return {
    total,
    average: scores.length === 0 ? 0 : total,
    highest: scores.length === 0 ? null : Math.max(...scores),
  };
}
