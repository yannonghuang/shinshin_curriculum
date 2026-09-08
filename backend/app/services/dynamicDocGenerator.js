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
const JSZip = require("jszip");

const LESSON_ORDINALS = [
  "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
];
const lessonOrdinal = (n) => LESSON_ORDINALS[n - 1] || `${n}`;

const title = (text) => new Paragraph({ text, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER });
const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
const h3 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_3 });
const h4 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_4 });
const HEADINGS_BY_DEPTH = [h1, h2, h3, h4];
const headingAt = (depth) => HEADINGS_BY_DEPTH[Math.min(depth, HEADINGS_BY_DEPTH.length) - 1];

// Some source templates author their field text with its own trailing colon
// already in the paragraph (e.g. the 2026 template's "1.认知思维目标：") --
// stripped here before appending "：" so those don't end up "：：". A no-op
// for every existing template's labels (none end in a colon), so this
// changes nothing about current output.
// `bold` defaults to true -- the original blanket behavior, kept for every
// caller that doesn't pass a field-level bold signal (meta rows, and any
// legacy schema whose fields never captured one -- see templateParser.js's
// EXCLUDED_TOP_LEVEL_LABELS-adjacent bold capture on parseHeadingSections'
// fields). A heading-parsed field's real bold-ness (the real template mixes
// bold and non-bold labels -- confirmed on the 2026 template) is passed
// explicitly instead, so generation reproduces the template's own choice
// rather than inventing one.
const p = (label, value, bold = true) => {
  const cleanLabel = label ? String(label).replace(/[:：]\s*$/, "") : label;
  return new Paragraph({
    children: [
      new TextRun({ text: cleanLabel ? `${cleanLabel}：` : "", bold: !!cleanLabel && bold }),
      new TextRun({ text: value != null && value !== "" ? String(value) : "（未填写）" }),
    ],
  });
};

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
// Used as-is for a section with no true nested outline (every table-shaped,
// flat-shaped, or hand-authored schema -- see templateParser.js); a heading-
// style-parsed section instead recurses through its real `subsections` (see
// renderSectionTree below), and this only renders each subsection's own
// direct fields, one level at a time.
const buildFieldChildren = (fields, values) => {
  const children = [];
  let lastGroup;
  (fields || []).forEach((field) => {
    if (field.group !== lastGroup) {
      if (field.group) children.push(h2(field.group));
      lastGroup = field.group;
    }
    children.push(p(field.label, values[field.key], field.bold === undefined ? true : field.bold));
  });
  return children;
};

// Recurses through one node of a heading-style-parsed section's true nested
// outline (subsections -- see templateParser.js#parseHeadingSections),
// emitting a heading for this node followed by its own *direct* fields
// (node.fields on a subsection is always direct-only, unlike a top-level
// section's flattened `fields` -- see buildSchemaChildren below), then
// descending into its children. `values` stays the single flat per-top-
// level-section answers object throughout -- field keys are globally unique
// across the whole schema, so no per-depth namespacing is needed (see
// mergeFormData/onFormFieldChange on the frontend, which rely on this same
// flat-within-a-top-section convention).
const renderSectionTree = (node, depth, values) => {
  const children = [headingAt(depth)(node.label || node.key)];
  children.push(...buildFieldChildren(node.fields, values));
  (node.subsections || []).forEach((child) => children.push(...renderSectionTree(child, depth + 1, values)));
  return children;
};

const buildSchemaChildren = (schema, answers) => {
  const children = [];
  (schema.sections || []).forEach((section) => {
    const values = sectionAnswers(schema, answers, section);
    if (section.subsections && section.subsections.length > 0) {
      // Unlike the legacy branch below (where a lone section's label was
      // synthetic -- "字段"/"main", never a real heading in the source
      // template), a heading-style-parsed top-level section's label IS a
      // real heading (e.g. "课程设计框架" -- see templateParser.js#
      // parseHeadingSections), so it's always rendered, at the source
      // template's own depth-1, with its subsections following at their own
      // true depths -- full structural fidelity to the uploaded template.
      children.push(h1(section.label || section.key));
      // section.ownFields (direct-only) here, not section.fields -- the
      // latter is the flattened all-descendants list kept for backward
      // compatibility, and rendering both would duplicate every field
      // already covered by the subsections recursion below.
      children.push(...buildFieldChildren(section.ownFields || [], values));
      section.subsections.forEach((child) => children.push(...renderSectionTree(child, 2, values)));
      return;
    }
    if (schema.sections.length > 1) children.push(h1(section.label || section.key));
    children.push(...buildFieldChildren(section.fields, values));
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
// meta rows are [label, value] or [label, value, bold] -- bold defaults to
// true (see p()) when the caller doesn't know the source template's real
// choice for that label (see templateParser.js's basicInfoBold, which the
// caller resolves per label before building this array).
// stylesXml: the source template's own word/styles.xml (see
// templateParser.js#extractStylesXml), when the pinned template version came
// from an upload -- passed straight through to docx's `externalStyles`, so
// heading/body fonts and sizes come from the real template instead of
// docx's own defaults. docx's default heading style IDs (Heading1, Heading2,
// ...) match Word's own, so this needs no ID remapping. Omitted entirely
// (unchanged default styling) for hand-authored seed template versions,
// which have no source file to pull real styles from.
// numberingXml: the source template's own word/numbering.xml (see
// templateParser.js#extractNumberingXml) -- a heading style's real "2.1"-
// style multi-level numbering and each level's indentation are defined
// there, not in styles.xml (a style's <w:numPr> is just a numId reference
// into it), so externalStyles alone reproduces the heading fonts but not
// the numbering/indentation. docx has no raw-XML hook for numbering.xml the
// way it does for styles.xml, so this is spliced into the already-built
// buffer's word/numbering.xml entry afterwards (via jszip) instead --
// swapping it wholesale is safe because nothing generated here defines any
// numbering of its own, and the real numbering.xml's numIds already agree
// with the real styles.xml's <w:numPr> references (both come from the same
// source file). No-op when the template has none (or wasn't uploaded).
async function generateDoc({ docTitle, meta, schema, answers, trailingChildren, stylesXml, numberingXml }) {
  const children = [title(docTitle)];
  (meta || []).forEach(([label, value, bold]) => children.push(p(label, value, bold === undefined ? true : bold)));
  children.push(...buildSchemaChildren(schema, answers));
  if (trailingChildren) children.push(...trailingChildren);

  const doc = new Document(stylesXml ? { externalStyles: stylesXml, sections: [{ children }] } : { sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  if (!numberingXml) return buffer;

  const zip = await JSZip.loadAsync(buffer);
  zip.file("word/numbering.xml", numberingXml);
  return zip.generateAsync({ type: "nodebuffer" });
}

// "第二部分：分课时设计" tail -- freeform per-课时 title+content, not part of
// the field-template mechanism (see EMPTY_LESSON). Shared by
// plan.controller.js#renderDoc (the downloadable doc) and
// planContext.js#buildPlanContentText (AI-review/co-pilot content) so both
// use the same lesson-count fallback and can't drift apart on how many
// lessons they render.
// Fallback heading text -- used only when the pinned template's own schema
// didn't capture real wording for this section (every schema parsed before
// templateParser.js#parseHeadingSections existed, a table/flat-parsed one,
// or a heading-parsed template that simply has no such heading at all).
// Never hardcoded for a template that DOES have one -- see
// templateParser.js's lessonBreakdownLabel, captured from the template's own
// heading text (e.g. "分课时设计") instead of assuming this exact wording.
const DEFAULT_LESSON_BREAKDOWN_LABEL = "第二部分：分课时设计";

const buildLessonDesignTrailingChildren = (plan) => {
  const lessons = Array.isArray(plan.planFormData && plan.planFormData.lessons) ? plan.planFormData.lessons : [];
  const lessonCount = plan.plannedLessonCount || lessons.length || 0;
  const schema = plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson;
  const heading = (schema && schema.lessonBreakdownLabel) || DEFAULT_LESSON_BREAKDOWN_LABEL;
  const children = [h1(heading)];
  if (lessonCount > 0) {
    for (let i = 1; i <= lessonCount; i += 1) {
      const lesson = lessons.find((l) => Number(l.index) === i) || {};
      // Plain bold-label paragraph, not a heading -- the real template has
      // no heading style on "第一课时：" (confirmed: no w:pStyle, just a bold
      // run), matching every other field label's shape (see p()) rather
      // than inventing a heading level that isn't in the source.
      children.push(p(`第${lessonOrdinal(i)}课时`, lesson.title));
      children.push(...multiline(lesson.content));
    }
  } else {
    children.push(plain(""));
  }
  return children;
};

module.exports = {
  generateDoc,
  title,
  h1,
  h2,
  h3,
  p,
  plain,
  multiline,
  lessonOrdinal,
  buildLessonDesignTrailingChildren,
};
