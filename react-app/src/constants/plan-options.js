// 乡土主题 taxonomy for 乡土课程设计 theme tagging/browsing -- kept in sync with
// backend/app/models/index.js's db.PLAN_THEMES (server-side validation).
export const PLAN_THEMES = [
  "自然地理风貌",
  "生计方式实践",
  "家乡物产探索",
  "家乡美食文化",
  "村落民居文化",
  "家族历史故事",
  "传统节日民俗",
  "家乡人物故事",
  "童谣民歌俗语",
  "民族服饰文化",
  "家乡游戏娱乐",
  "传统手艺制作",
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
// beneath it. Used by plan-detail.component.js (a 课时 N pane's lesson-design
// form) -- see also backend/app/services/planDocExtract.js#extractLessonsFromText
// (an uploaded .docx's best-effort extraction into this same shape) and
// dynamicDocGenerator.js, which renders plan.planFormData.lessons (an array
// of these, keyed by `index`) back into "第二部分：分课时设计" when generating
// a plan's 课程设计文件.
export const EMPTY_LESSON = { title: "", content: "" };
