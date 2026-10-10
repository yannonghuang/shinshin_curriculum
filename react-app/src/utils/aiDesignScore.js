// AI 设计分数 display helpers (score shape: review.controller.js#attachAiScores).

// "62 / 100" (or just "62" when the standard's 满分 is unknown).
export const aiDesignScoreText = (s) => `${s.totalScore}${s.maxScore ? ` / ${s.maxScore}` : ""}`;
