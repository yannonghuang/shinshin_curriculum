// AI 设计分数's hover text (see review.controller.js#attachAiScores for the
// score's shape): the standard it was scored against, then per dimension
// the score it got and that dimension's 考察要点.
export const aiDesignScoreTooltip = (s) => {
  const scored = new Map((s.dimensionScores || []).map((d) => [d.name, d]));
  const dims = (s.criteria || []).length > 0 ? s.criteria : s.dimensionScores || [];
  const blocks = dims.map((dim) => {
    const got = scored.get(dim.name);
    const head = `【${dim.name}】${got ? `${got.score}/${dim.weight}${got.level ? `（${got.level}）` : ""}` : `满分 ${dim.weight}`}`;
    return [head, ...(dim.criteria || []).map((c) => `· ${c}`)].join("\n");
  });
  return [
    `评分标准：${s.standardTitle || "AI 点评标准"}（#${s.standardId}${s.maxScore ? `，满分 ${s.maxScore}` : ""}）`,
    ...blocks,
    s.summary && `总评：${s.summary}`,
    s.scoredAt && `打分于 ${new Date(s.scoredAt).toLocaleString()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

// "62 / 100" (or just "62" when the standard's 满分 is unknown).
export const aiDesignScoreText = (s) => `${s.totalScore}${s.maxScore ? ` / ${s.maxScore}` : ""}`;
