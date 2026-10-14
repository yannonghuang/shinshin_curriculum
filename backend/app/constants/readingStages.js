// 课程标准学段 -- the grade bands 课外读物推荐 groups its output by (the same
// bands 义务教育语文课程标准 uses for its reading requirements). The page gets
// them from GET /api/book-recommendations/options.
const STAGES = [
  { key: "1-2", label: "第一学段（1—2年级）" },
  { key: "3-4", label: "第二学段（3—4年级）" },
  { key: "5-6", label: "第三学段（5—6年级）" },
  { key: "7-9", label: "第四学段（7—9年级）" },
];
const STAGE_KEYS = STAGES.map((s) => s.key);
const stageLabel = (key) => (STAGES.find((s) => s.key === key) || { label: key }).label;

module.exports = { STAGES, STAGE_KEYS, stageLabel };
