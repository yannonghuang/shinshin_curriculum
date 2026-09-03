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
// current calendar year (see plans-list.component.js's openCreateEditor).
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

// The online-fill WHY/WHAT/HOW form's field shape, matching
// curriculum_template/乡土课程设计方案模版.docx's structure. Shared between
// plan-detail.component.js (the online-fill form itself) and
// plans-list.component.js (best-effort extraction from an uploaded .docx,
// so an uploaded plan renders through the same section-by-section form
// instead of just an attached file -- see extractWhyWhatHowFromText).
export const EMPTY_WHY_WHAT_HOW = {
  why: {
    cognitiveGoals: "",
    practicalGoals: "",
    socialEmotionalGoals: "",
    otherGoals: "",
  },
  what: {
    projectIntro: "",
    drivingQuestion: "",
    finalOutcomePersonal: "",
    finalOutcomeTeam: "",
    publicDisplayMethod: "",
  },
  how: {
    entryActivity: "",
    teacherStudentDiscussion: "",
    outcomeDisplayDiscussion: "",
    requirementsChecklist: "",
    knowledgeExploration: "",
    productMaking: "",
    reflectionIteration: "",
    finalOutcomeDisplay: "",
    reflectionSummary: "",
    materialsNeeded: "",
    resourcesNeeded: "",
  },
};

// [path, label] pairs in the template's document order -- label is the exact
// Chinese heading/field-name text to search for in extracted docx text.
export const WHY_WHAT_HOW_FIELD_LABELS = [
  ["why.cognitiveGoals", "认知思维目标"],
  ["why.practicalGoals", "实践技能目标"],
  ["why.socialEmotionalGoals", "社会情感目标"],
  ["why.otherGoals", "其他目标"],
  ["what.projectIntro", "项目介绍"],
  ["what.drivingQuestion", "驱动问题"],
  ["what.finalOutcomePersonal", "个人成果"],
  ["what.finalOutcomeTeam", "团队成果"],
  ["what.publicDisplayMethod", "公开展示方式"],
  ["how.entryActivity", "入项活动"],
  ["how.teacherStudentDiscussion", "师生共议驱动问题"],
  ["how.outcomeDisplayDiscussion", "讨论最终成果及展示"],
  ["how.requirementsChecklist", "讨论须知清单"],
  ["how.knowledgeExploration", "知识探究"],
  ["how.productMaking", "产品制作"],
  ["how.reflectionIteration", "反思与迭代"],
  ["how.finalOutcomeDisplay", "最终成果展示"],
  ["how.reflectionSummary", "复盘反思"],
  ["how.materialsNeeded", "需要的材料"],
  ["how.resourcesNeeded", "需要链接的资源"],
];

// A single 第N课时 entry from the template's "第二部分：分课时设计" -- unlike Part 1's
// fixed WHY/WHAT/HOW fields, the template leaves each lesson entirely freeform
// ("第一课时：" followed by a blank line, no further sub-labels), so this is the
// whole per-lesson shape: an optional inline title right after the "第N课时："
// heading (e.g. "第1课时：入项激趣——认识一种...的米饼") plus the freeform body
// beneath it. Shared between plan-detail.component.js (a 课时 N pane's lesson-design
// form) and plans-list.component.js (extractLessonsFromText's best-effort
// extraction from an uploaded .docx) -- see also planDocGenerator.js, which
// renders plan.planFormData.lessons (an array of these, keyed by `index`) back
// into "第二部分：分课时设计" when generating a plan's 课程设计文件.
export const EMPTY_LESSON = { title: "", content: "" };

// The online-fill 实施记录 form's field shape, matching
// curriculum_template/课时实施记录模板.docx's structure -- flat (no
// why/what/how-style section nesting), unlike the plan's own template.
// Shared between plan-detail.component.js (the 实施记录 form itself, and
// 课程实施文件's 上传 command) and backend/app/services/
// lessonExecutionDocGenerator.js (which renders it back into a .docx for
// 课程实施文件's 下载/预览 and AI review). Stored on plan.executionFormData
// as a sparse array keyed by lesson index, mirroring planFormData.lessons:
// [{ index: 1, lessonGoals: "...", ... }].
//
// Note: the template's last field label ("观察和反思") is literally cut off
// mid-word in the source .docx ("观察和反") -- this spells it out in full,
// the assumed intended wording.
export const EMPTY_EXECUTION_RECORD = {
  lessonGoals: "",
  materialsPreparation: "",
  evidenceToCollect: "",
  teacherActions: "",
  studentActions: "",
  processOutcomes: "",
  observationReflection: "",
};

// [field, label] pairs in the template's document order -- label is the
// exact Chinese heading/field-name text to search for in extracted docx
// text (see utils/planDocExtract.js's extractExecutionRecordFromText).
export const EXECUTION_RECORD_FIELD_LABELS = [
  ["lessonGoals", "本课时目标"],
  ["materialsPreparation", "所需材料及准备"],
  ["evidenceToCollect", "需要收集的学习证据"],
  ["teacherActions", "教师做了什么"],
  ["studentActions", "学生做了什么"],
  ["processOutcomes", "过程和成果"],
  ["observationReflection", "观察和反思"],
];
