// Migrated from shinshin's react-app/src/constants/case-options.js's
// CASE_CATEGORIES_BY_COURSE['乡土课程'] -- the already-curated 11-item local-curriculum-theme
// taxonomy, reused here for 乡土课程设计 theme tagging/browsing.
export const PLAN_THEMES = [
  "家乡美食与饮食文化",
  "非遗与传统手工艺",
  "乡土游戏与童年记忆",
  "传统节日与民俗活动",
  "家乡名人与文化传承",
  "植物探索与劳动实践",
  "乡土艺术与创意表达",
  "家乡物产与经济生活",
  "家乡地理与生态保护",
  "家乡历史与地方记忆",
  "民谣方言/家乡服饰/家乡特色建筑",
];

export const PLAN_GRADES = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级"];

// 学期 -- alongside year, drives the manager/expert plan list's year-学期 ->
// teacher navigation (plans-hierarchy.component.js). Chinese school terms:
// 秋季学期 roughly Aug-Jan, 春季学期 roughly Feb-Jul.
export const PLAN_SEASONS = ["秋季", "春季"];

// Defaults a new plan's 学期 the same way its 年份 already defaults to the
// current calendar year (see plans-list.component.js's createEmptyPlan and
// plan-detail.component.js's metaForm seeding).
export const currentSeason = () => {
  const month = new Date().getMonth() + 1; // 1-12
  return month >= 2 && month <= 7 ? "春季" : "秋季";
};

export const PLAN_MODES = [
  { value: "upload", label: "上传文件" },
  { value: "online", label: "在线填写" },
];

export const PLAN_STATUSES = [
  { value: "draft", label: "草稿" },
  { value: "submitted", label: "已提交" },
  { value: "reviewed", label: "已点评" },
];

// artifacts.category values, split by scope (plan-level 课程设计文件 vs per-课时 实施记录).
export const ARTIFACT_CATEGORIES_PLAN_LEVEL = ["课程设计文件"];
export const ARTIFACT_CATEGORIES_LESSON_LEVEL = ["实施记录文件", "课件PPT", "图片", "视频"];
export const ARTIFACT_CATEGORIES = [...ARTIFACT_CATEGORIES_PLAN_LEVEL, ...ARTIFACT_CATEGORIES_LESSON_LEVEL];

// A single 第N课时 entry from the template's "第二部分：分课时设计" -- unlike Part 1's
// fixed WHY/WHAT/HOW fields, the template leaves each lesson entirely freeform
// ("第一课时：" followed by a blank line, no further sub-labels), so this is the
// whole per-lesson shape: an optional inline title right after the "第N课时："
// heading (e.g. "第1课时：入项激趣——认识一种...的米饼") plus the freeform body
// beneath it. Shared between plan-detail.component.js (a 课时 N pane's lesson-design
// form) and plans-list.component.js (extractLessonsFromText's best-effort
// extraction from an uploaded .docx) -- see also dynamicDocGenerator.js, which
// renders plan.planFormData.lessons (an array of these, keyed by `index`) back
// into "第二部分：分课时设计" when generating a plan's 课程设计文件.
export const EMPTY_LESSON = { title: "", content: "" };
