// Renders a template_versions schema + its answers into a downloadable
// .docx -- the single generic engine behind both 课程设计文件's and 课程实施
// 文件's 下载/预览 (plan.controller.js#renderDoc/#renderExecutionDoc) and AI
// review's on-the-fly rendering (review.controller.js), replacing the two
// hard-coded generators (planDocGenerator.js, lessonExecutionDocGenerator.js)
// that used to each encode the same shape by hand.
//
// Answers shape note: a plan's planFormData is nested by section key
// (`{ why: { cognitiveGoals: "..." }, what: {...}, how: {...} }`, matching
// the online-fill form's existing multi-section layout) while one 实施记录
// entry is flat (`{ lessonGoals: "...", teacherActions: "...", ... }`,
// since its schema has exactly one section) -- both are the *existing*
// stored JSON shapes, unchanged by this feature (see the dynamic-templates
// plan's "no existing plan data needs converting" note), so section-answer
// lookup below branches on section count rather than forcing one convention.
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require("docx");

const LESSON_ORDINALS = [
  "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
];
const lessonOrdinal = (n) => LESSON_ORDINALS[n - 1] || `${n}`;

const title = (text) => new Paragraph({ text, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER });
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

// A field that can legitimately hold multiple lines (a 课时's own design
// content) -- unlike `p`/`plain`, which show one "（未填写）" line for
// anything falsy, this only does that for a genuinely empty field; a
// filled-in one keeps its line breaks as separate paragraphs.
const multiline = (text) => {
  const str = text != null ? String(text) : "";
  if (str.trim() === "") return [plain("")];
  return str.split("\n").map((line) => new Paragraph({ text: line }));
};

const sectionAnswers = (schema, answers, section) => {
  const all = answers || {};
  return schema.sections.length > 1 ? all[section.key] || {} : all;
};

// Groups consecutive same-`group` fields under one h2 sub-heading -- the
// same shape hand-built for 实施记录's 教学活动流程 this session, now generic.
const buildSchemaChildren = (schema, answers) => {
  const children = [];
  (schema.sections || []).forEach((section) => {
    if (schema.sections.length > 1) children.push(h1(section.label || section.key));
    const values = sectionAnswers(schema, answers, section);
    let lastGroup;
    (section.fields || []).forEach((field) => {
      if (field.group !== lastGroup) {
        if (field.group) children.push(h2(field.group));
        lastGroup = field.group;
      }
      children.push(p(field.label, values[field.key]));
    });
  });
  return children;
};

// meta: [[label, value], ...] printed right under the title, before any
// section (课程名称/任教年级/预计课时 for a plan doc, etc.).
// trailingChildren: extra Paragraph objects appended after the schema
// sections -- used for 课程设计文件's "第二部分：分课时设计" tail, which is
// freeform per-课时 title+content and isn't part of the field-template
// mechanism at all (see EMPTY_LESSON), so it's composed by the caller
// (plan.controller.js#renderDoc) using the h3/multiline/lessonOrdinal
// helpers exported below, not driven by any schema.
async function generateDoc({ docTitle, meta, schema, answers, trailingChildren }) {
  const children = [title(docTitle)];
  (meta || []).forEach(([label, value]) => children.push(p(label, value)));
  children.push(...buildSchemaChildren(schema, answers));
  if (trailingChildren) children.push(...trailingChildren);

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { generateDoc, title, h1, h2, h3, p, plain, multiline, lessonOrdinal };
