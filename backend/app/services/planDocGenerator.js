// Renders a plan's `planFormData` (the online-fill WHY/WHAT/HOW template
// answers) into a downloadable .docx mirroring the structure of
// curriculum_template/乡土课程设计方案模版.docx:
//
//   课程名称 / 任教年级 / 执教人 / 预计课时
//   第一部分 课程设计框架
//     WHY  - 学习目标 (认知思维目标/实践技能目标/社会情感目标/其他目标)
//     WHAT - 项目简介 (项目介绍/驱动问题/最终成果[个人成果/团队成果]/公开展示方式)
//     HOW  - 活动设计
//       一、入项 (入项活动/师生共议驱动问题/讨论最终成果及展示/讨论须知清单)
//       探究与制作 (知识探究/产品制作/反思与迭代 - each a list of per-课时 entries)
//       三、出项 (最终成果展示/复盘反思)
//       需要的材料 / 需要链接的资源
//   第二部分：分课时设计 (第一课时..第N课时)
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} = require("docx");

const LESSON_ORDINALS = [
  "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
];

const lessonOrdinal = (n) => LESSON_ORDINALS[n - 1] || `${n}`;

const title = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
  });

const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
const h3 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_3 });

const p = (label, value) =>
  new Paragraph({
    children: [
      new TextRun({ text: label ? `${label}：` : "", bold: !!label }),
      new TextRun({ text: value != null && value !== "" ? String(value) : "（未填写）" }),
    ],
  });

const plain = (text) => new Paragraph({ text: text != null && text !== "" ? String(text) : "（未填写）" });

// A field that can legitimately hold multiple lines (HOW's per-课时 lists, a
// 课时's own content) -- unlike `p`/`plain`, which show a single "（未填写）"
// paragraph for anything falsy, this only does that for a field with *nothing*
// in it; a filled-in field keeps its line breaks as separate paragraphs rather
// than being flattened (Paragraph's own `text` has no notion of a line break).
const multiline = (text) => {
  const str = text != null ? String(text) : "";
  if (str.trim() === "") return [plain("")];
  return str.split("\n").map((line) => new Paragraph({ text: line }));
};

function buildParagraphs(plan) {
  const data = plan.planFormData || {};
  const why = data.why || {};
  const what = data.what || {};
  const how = data.how || {};
  const lessons = Array.isArray(data.lessons) ? data.lessons : [];

  const children = [];

  children.push(title("乡土课程设计方案"));
  children.push(p("课程名称", plan.title));
  children.push(p("任教年级", plan.grade));
  children.push(p("预计课时", plan.plannedLessonCount));

  children.push(h1("第一部分 课程设计框架"));

  children.push(h2("WHY"));
  children.push(h3("学习目标"));
  children.push(p("认知思维目标", why.cognitiveGoals));
  children.push(p("实践技能目标", why.practicalGoals));
  children.push(p("社会情感目标", why.socialEmotionalGoals));
  children.push(p("其他目标", why.otherGoals));

  children.push(h2("WHAT"));
  children.push(h3("项目简介"));
  children.push(p("1. 项目介绍（为什么做这个乡土主题？）", what.projectIntro));
  children.push(p("2. 驱动问题（儿童视角）", what.drivingQuestion));
  children.push(new Paragraph({ text: "3. 最终成果", bold: true }));
  children.push(p("个人成果", what.finalOutcomePersonal));
  children.push(p("团队成果", what.finalOutcomeTeam));
  children.push(p("4. 公开展示方式", what.publicDisplayMethod));

  children.push(h2("HOW"));
  children.push(h3("活动设计"));

  children.push(h3("一、入项（1-2课时）"));
  children.push(p("入项活动", how.entryActivity));
  children.push(p("师生共议驱动问题", how.teacherStudentDiscussion));
  children.push(p("讨论最终成果及展示", how.outcomeDisplayDiscussion));
  children.push(p("讨论须知清单", how.requirementsChecklist));

  children.push(h3("探究与制作（4课时以上）"));
  children.push(new Paragraph({ text: "知识探究", bold: true }));
  children.push(...multiline(how.knowledgeExploration));
  children.push(new Paragraph({ text: "产品制作", bold: true }));
  children.push(...multiline(how.productMaking));
  children.push(new Paragraph({ text: "反思与迭代", bold: true }));
  children.push(...multiline(how.reflectionIteration));

  children.push(h3("三、出项（1-2课时）"));
  children.push(p("最终成果展示", how.finalOutcomeDisplay));
  children.push(p("复盘反思", how.reflectionSummary));

  children.push(p("需要的材料", how.materialsNeeded));
  children.push(p("需要链接的资源", how.resourcesNeeded));

  children.push(h1("第二部分：分课时设计"));
  const lessonCount = plan.plannedLessonCount || lessons.length || 0;
  if (lessonCount > 0) {
    for (let i = 1; i <= lessonCount; i += 1) {
      const lesson = lessons.find((l) => Number(l.index) === i) || {};
      children.push(h3(`第${lessonOrdinal(i)}课时：${lesson.title || ""}`));
      children.push(...multiline(lesson.content));
    }
  } else {
    children.push(plain(""));
  }

  return children;
}

async function generatePlanDocx(plan) {
  const children = buildParagraphs(plan);
  const doc = new Document({
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { generatePlanDocx };
