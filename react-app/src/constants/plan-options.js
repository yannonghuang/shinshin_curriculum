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

// reviews.section_key options -- expert reviewers target one section of the WHY/WHAT/HOW
// template (or leave it free-text); AI reviews always target the whole document/lesson.
export const REVIEW_SECTIONS = ["WHY", "WHAT", "HOW", "自由文本"];
