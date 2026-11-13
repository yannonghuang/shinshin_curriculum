// The curriculum framework's own terms, as the 学习资源库 training materials
// (王海英's 新乡土课程 lectures/纪要, 9/17 workshop) define them -- one source
// for every AI path that writes or reads a plan's 学习目标 (欣欣小助手's
// focus block, planDrafter's outline), so they can't drift apart.
//
// Why this exists: with no definition in front of it, the model read
// 社会情感目标 as the 课标's 情感态度与价值观 (文化认同, 家国情怀), then
// defended that against the user's "this isn't SEL" -- while the library
// says 社会情感 *is* SEL (CASEL's five competencies, framed as 关系能力) and
// the rubric requires "有SEL目标表述". Keep these in step with the library.

// 社会情感 in the library's words, without this project's placement rule --
// also what 全部乡土课程's 语义搜索 compares a plan's 社会情感目标 against
// (planSearch.js), with SEL_CONTRAST as what it must not reward.
const SEL_CORE =
  "即社会情感学习（SEL，Social-Emotional Learning），采用 CASEL 五大核心能力：自我意识、自我管理、社会意识、关系技能、负责任的决策。" +
  "资源库培训中讲师将其归纳为「关系能力」：自我与自我的关系（自我意识、自我管理），自我与他人的关系（社会意识、关系技能、负责任的决策）。" +
  "培训明确指出 SEL 比传统的「情感态度与价值观」更具体、实在、全面；目标要先行写明，再在 PBL 各环节渗透。";
const SEL_CONTRAST = "文化认同、家乡自豪感、传承责任、热爱家乡、非遗传承、文化自信";

// The template's WHY 学习目标 fields, in template order, with what each one
// means. `category` is also the tag planDrafter's outline files goals under.
// `searchContrast` (optional): what a search for good goals of this
// category must rank down (planSearch.js).
const GOAL_CATEGORIES = [
  {
    category: "认知思维",
    definition: "知道什么、理解什么（KUD 中的 K 与 U）：事实性知识、核心概念与规律、背后的原理与意义。",
  },
  {
    category: "实践技能",
    definition: "能做到什么（KUD 中的 D）：观察、调查、访谈、动手制作、表达展示等可观察、可检验的能力。",
  },
  {
    category: "社会情感",
    searchText: SEL_CORE,
    searchContrast: SEL_CONTRAST,
    definition:
      SEL_CORE +
      "评价标准中，目标设计达到合格需「有SEL目标表述」，示范级要求任务链「每环节有SEL渗透和培养」。" +
      // Project decision (2026-11-12): the template's 社会情感目标 field is
      // SEL only; 情感/文化 goals go to 其他目标.
      "本项目约定：课程设计模板中的「社会情感目标」一栏只写 SEL 目标，每条都应能对应上述五大能力之一并写得具体、可观察。" +
      "文化认同、家乡自豪感、传承责任等属于情感/文化目标（对应「五根」中的文化之根，也是 KUD+S 中 S 的一部分），但不是 SEL，应写入「其他目标」一栏；" +
      "这类目标出现在本栏，属于填写位置有误，应建议移到「其他目标」，并补充真正的 SEL 目标。",
  },
  {
    category: "跨学科融合",
    definition: "课程涉及哪些学科、每个学科对应课时里的哪项具体活动（有广度：打开学科边界）。",
  },
  {
    category: "其它",
    definition:
      "以上类别都不适合的目标，包括文化认同、家乡自豪感、传承责任等情感/文化目标（KUD+S 中 S 里非 SEL 的部分）——这类目标写在这里，不写进「社会情感目标」。",
  },
];

const GOAL_CATEGORY_NAMES = GOAL_CATEGORIES.map((c) => c.category);

// Other framework terms a reading of the 学习目标 commonly leans on.
const FRAMEWORK_TERMS = [
  "KUD+S 目标：K 知道什么、U 理解什么、D 能做到什么、S 感受到什么（情感/文化/SEL）；示范级要求四维度完整并标注培育「五根」中的哪几根。" +
    "在本项目的模板中，S 的 SEL 部分写入「社会情感目标」，情感/文化部分写入「其他目标」。",
  "五根：身体之根、心理之根（安全感、归属感、自我效能）、文化之根、智慧之根、实践之根。",
  "PBL+SEL 任务链：入项 → 探究 → 制作（与迭代）→ 出项，PBL 与 SEL 呈双螺旋结构，每个环节都要有 SEL 渗透点。",
];

// The goal category a focus label names ("社会情感目标：" -> "社会情感"),
// or null. Template labels carry the trailing colon; 其他/其它 both occur.
const goalCategoryOf = (label) => {
  const clean = String(label || "").replace(/[：:\s]+$/, "").replace(/目标$/, "").replace("其他", "其它");
  return GOAL_CATEGORY_NAMES.includes(clean) ? clean : null;
};

// What a search for well-set goals of one category compares against: the
// category's own meaning (`positive`) and, if any, what it must not reward
// (`contrast`). Null for a non-goal category.
const goalSearchProfile = (category) => {
  const c = GOAL_CATEGORIES.find((g) => g.category === category);
  if (!c) return null;
  return { positive: c.searchText || c.definition, contrast: c.searchContrast || null };
};

// Block for the system prompt when the user is on a 学习目标 field/section:
// the focused category's definition first, then the rest for comparison.
const describeGoalFramework = (focusedCategory) => {
  const ordered = focusedCategory
    ? [...GOAL_CATEGORIES.filter((c) => c.category === focusedCategory), ...GOAL_CATEGORIES.filter((c) => c.category !== focusedCategory)]
    : GOAL_CATEGORIES;
  return (
    "【课程框架术语（来自学习资源库培训材料，解读和评价学习目标时以此为准）】\n" +
    ordered.map((c) => `- ${c.category}目标：${c.definition}`).join("\n") +
    "\n" +
    FRAMEWORK_TERMS.map((t) => `- ${t}`).join("\n") +
    "\n解读这一栏时，不要只复述作者写了什么：要对照上述定义，指出哪些目标符合该类别的含义、哪些其实属于别的类别或缺了哪些方面。" +
    "需要更多原文依据时调用 search_knowledge_base。"
  );
};

module.exports = { GOAL_CATEGORIES, GOAL_CATEGORY_NAMES, FRAMEWORK_TERMS, goalCategoryOf, goalSearchProfile, describeGoalFramework };
