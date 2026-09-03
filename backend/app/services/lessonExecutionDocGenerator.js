// Renders one lesson's `plan.executionFormData` entry (the online-fill
// 实施记录 template answers) into a downloadable .docx mirroring the
// structure of curriculum_template/课时实施记录模板.docx:
//
//   1. 本课时目标
//   2. 所需材料及准备
//   3. 需要收集的学习证据
//   4. 教学活动流程
//      教师做了什么 / 学生做了什么 / 过程和成果 / 观察和反思
const { Document, Packer, Paragraph, HeadingLevel, AlignmentType, TextRun } = require("docx");

const title = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
  });

const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });

const p = (label, value) =>
  new Paragraph({
    children: [
      new TextRun({ text: label ? `${label}：` : "", bold: !!label }),
      new TextRun({ text: value != null && value !== "" ? String(value) : "（未填写）" }),
    ],
  });

const findExecutionRecord = (plan, lessonIndex) => {
  const records = Array.isArray(plan.executionFormData) ? plan.executionFormData : [];
  return records.find((r) => Number(r.index) === Number(lessonIndex)) || {};
};

// Any of the 7 template fields non-empty after trim -- used by
// review.controller.js to decide whether a lesson has a written 实施记录
// worth preferring over its uploaded 支撑材料.
const hasExecutionRecordContent = (record) =>
  ["lessonGoals", "materialsPreparation", "evidenceToCollect", "teacherActions", "studentActions", "processOutcomes", "observationReflection"].some(
    (field) => (record && record[field] ? String(record[field]).trim() : "") !== ""
  );

function buildParagraphs(plan, lessonIndex) {
  const r = findExecutionRecord(plan, lessonIndex);

  const children = [];
  children.push(title(`课时实施记录 · 第${lessonIndex}课时`));
  children.push(p("本课时目标", r.lessonGoals));
  children.push(p("所需材料及准备", r.materialsPreparation));
  children.push(p("需要收集的学习证据", r.evidenceToCollect));

  children.push(h2("教学活动流程"));
  children.push(p("教师做了什么", r.teacherActions));
  children.push(p("学生做了什么", r.studentActions));
  children.push(p("过程和成果", r.processOutcomes));
  children.push(p("观察和反思", r.observationReflection));

  return children;
}

async function generateExecutionDocx(plan, lessonIndex) {
  const children = buildParagraphs(plan, lessonIndex);
  const doc = new Document({
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { generateExecutionDocx, findExecutionRecord, hasExecutionRecordContent };
