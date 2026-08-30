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

const list = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return [plain("")];
  }
  return items
    .filter((x) => x !== undefined && x !== null && x !== "")
    .map((item) => new Paragraph({ text: `- ${item}`, bullet: { level: 0 } }));
};

function buildParagraphs(plan) {
  const data = plan.planFormData || {};
  const why = data.why || {};
  const learningGoals = why.learningGoals || {};
  const what = data.what || {};
  const finalOutcome = what.finalOutcome || {};
  const how = data.how || {};
  const entry = how.entry || {};
  const inquiry = how.inquiry || {};
  const exit = how.exit || {};
  const lessons = Array.isArray(data.lessons) ? data.lessons : [];

  const children = [];

  children.push(title("乡土课程设计方案"));
  children.push(p("课程名称", data.courseName || plan.title));
  children.push(p("任教年级", data.grade || plan.grade));
  children.push(p("执教人", data.teacherName));
  children.push(p("预计课时", data.plannedLessonCount || plan.plannedLessonCount));

  children.push(h1("第一部分 课程设计框架"));

  children.push(h2("WHY"));
  children.push(h3("学习目标"));
  children.push(p("认知思维目标", learningGoals.cognitive));
  children.push(p("实践技能目标", learningGoals.practical));
  children.push(p("社会情感目标", learningGoals.social));
  children.push(p("其他目标", learningGoals.other));

  children.push(h2("WHAT"));
  children.push(h3("项目简介"));
  children.push(p("1. 项目介绍（为什么做这个乡土主题？）", what.projectIntro));
  children.push(p("2. 驱动问题（儿童视角）", what.drivingQuestion));
  children.push(new Paragraph({ text: "3. 最终成果", bold: true }));
  children.push(p("个人成果", finalOutcome.personal));
  children.push(p("团队成果", finalOutcome.team));
  children.push(p("4. 公开展示方式", what.publicDisplay));

  children.push(h2("HOW"));
  children.push(h3("活动设计"));

  children.push(h3("一、入项（1-2课时）"));
  children.push(p("入项活动", entry.activities));
  children.push(p("师生共议驱动问题", entry.discussDrivingQuestion));
  children.push(p("讨论最终成果及展示", entry.discussOutcomeAndDisplay));
  children.push(p("讨论须知清单", entry.requirementsChecklist));

  children.push(h3("探究与制作（4课时以上）"));
  children.push(new Paragraph({ text: "知识探究", bold: true }));
  children.push(...list(inquiry.knowledgeInquiry));
  children.push(new Paragraph({ text: "产品制作", bold: true }));
  children.push(...list(inquiry.production));
  children.push(new Paragraph({ text: "反思与迭代", bold: true }));
  children.push(...list(inquiry.reflection));

  children.push(h3("三、出项（1-2课时）"));
  children.push(p("最终成果展示", exit.finalShowcase));
  children.push(p("复盘反思", exit.retrospective));

  children.push(p("需要的材料", how.materialsNeeded));
  children.push(p("需要链接的资源", how.resourcesNeeded));

  children.push(h1("第二部分：分课时设计"));
  const lessonCount = plan.plannedLessonCount || lessons.length || 0;
  if (lessonCount > 0) {
    for (let i = 1; i <= lessonCount; i += 1) {
      const lesson = lessons.find((l) => Number(l.index) === i) || {};
      children.push(h3(`第${lessonOrdinal(i)}课时：${lesson.title || ""}`));
      children.push(plain(lesson.content));
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
