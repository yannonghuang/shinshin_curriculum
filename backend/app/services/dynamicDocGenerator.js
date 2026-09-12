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

// Explicit bold + size on the title's own run (rather than relying on
// whatever a "Title" style resolves to -- the real templates' own
// styles.xml never define one, see templateParser.js#extractStylesXml, so
// it would otherwise fall back to whichever app-specific default the
// viewer happens to have for that style ID, which isn't guaranteed to be
// bold or even larger than Heading1 e.g. in WPS). 40 half-points = 20pt.
const TITLE_FONT_SIZE = 40;
const title = (text) =>
  new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, bold: true, size: TITLE_FONT_SIZE })],
  });
const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
const h3 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_3 });
const h4 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_4 });
const HEADINGS_BY_DEPTH = [h1, h2, h3, h4];
const headingAt = (depth) => HEADINGS_BY_DEPTH[Math.min(depth, HEADINGS_BY_DEPTH.length) - 1];

// Gap after each non-heading "logic segment" (one field, one plain line, one
// 课时 marker) -- a heading's own before/after gap already comes from its
// style (see e.g. styles.xml's Heading1 w:spacing), but the Normal style
// every other paragraph falls back to defines none at all in the real
// templates, so consecutive fields render back-to-back with no visual
// separation unless set explicitly here. 200 twips = 10pt.
const SEGMENT_SPACING = { after: 200 };

// Every field label's own trailing colon is stripped here and replaced with
// a canonical full-width "：", so a label whose source paragraph already had
// one (e.g. the 2026 template's "1.认知思维目标：") doesn't end up "：：". Since
// templateParser.js#normalizeLabel already canonicalizes a label's trailing
// colon (to this same full-width form) at parse time, this is now a no-op
// for the common case -- kept anyway as the actual rendering guarantee (a
// hand-authored seed schema, e.g. schema.sql's, never goes through
// templateParser.js at all, and an old cached schemaJson row parsed before
// normalizeLabel existed may still carry a mixed-width colon) rather than
// relying solely on upstream data being clean.
// `bold` defaults to true -- the original blanket behavior, kept for every
// caller that doesn't pass a field-level bold signal (meta rows, and any
// legacy schema whose fields never captured one -- see templateParser.js's
// EXCLUDED_TOP_LEVEL_LABELS-adjacent bold capture on parseHeadingSections'
// fields). A heading-parsed field's real bold-ness (the real template mixes
// bold and non-bold labels -- confirmed on the 2026 template) is passed
// explicitly instead, so generation reproduces the template's own choice
// rather than inventing one.
// A value's own embedded "\n"s (e.g. a numbered list typed into a textarea,
// one item per line -- see 教学活动流程) render as literal whitespace if put
// straight into one TextRun's `text`, not as visible line breaks -- Word
// paragraphs don't interpret "\n" in run text at all, unlike a plain-text
// viewer. A first attempt used TextRun's `break` (a real <w:br/> within one
// paragraph) instead, but that's visibly wrong under the real templates'
// own Normal style, which is full-justified (w:jc="both"): justify's
// "don't stretch the last line" exception applies to a paragraph's true
// final line only, not to each line a manual break forces -- every other
// line (including an item's own natural word-wrap, not just the explicit
// break points) renders letter-spread edge-to-edge. Real separate
// paragraphs sidestep this entirely (each one *is* its own last line), so
// `p` returns an array of them -- like `multiline` already does -- with
// SEGMENT_SPACING only on the last (see callers, which spread this into
// their own children array).

// A field value's own "1. xxx" / "2. xxx" ... list collides visually with
// two other arabic-numeral schemes already in play in the same document:
// the field's own label, when the source template numbers its labels as
// literal text (e.g. "5.教学活动流程" -- see templateParser.js), and Word's
// own auto-numbered heading outline (Heading1/Heading2 both carry a real
// w:numPr/numId in the template's styles.xml). Detected as 2+ lines whose
// leading "N." marker increments 1, 2, 3... in the order they appear (so a
// line that merely starts with an unrelated digit, e.g. "10分钟...", can't
// false-trigger off a single match) -- when found, every matched marker is
// swapped for a Chinese-ordinal one ("一、二、三...", the same
// LESSON_ORDINALS map 课时 markers use) so the user's own list reads as
// clearly distinct from either surrounding scheme. Lines outside the
// detected sequence (blank lines, non-list prose) are left untouched.
const ARABIC_ITEM_MARKER = /^(\d+)[.．、]\s*/;
const renumberCollidingList = (lines) => {
  const matchedNumbers = lines.map((line) => {
    const m = line.match(ARABIC_ITEM_MARKER);
    return m ? Number(m[1]) : null;
  });
  const found = matchedNumbers.filter((n) => n !== null);
  const isSequentialList = found.length >= 2 && found.every((n, i) => n === i + 1);
  if (!isSequentialList) return lines;

  let seq = 0;
  return lines.map((line, i) => {
    if (matchedNumbers[i] === null) return line;
    seq += 1;
    return line.replace(ARABIC_ITEM_MARKER, `${lessonOrdinal(seq)}、`);
  });
};

const p = (label, value, bold = true, hint) => {
  const cleanLabel = label ? String(label).replace(/[:：]\s*$/, "") : label;
  const labelText = cleanLabel ? `${cleanLabel}：` : "";
  // An untouched field falls back to the template's own hint text (the
  // "-" lines under this field's label, see templateParser.js's
  // parseHeadingSections) rendered as normal answer text, rather than the
  // generic "（未填写）" placeholder -- so a hint the user never overrides
  // still appears in the downloaded file exactly as authored.
  const str = value != null && value !== "" ? String(value) : hint || "（未填写）";
  const lines = renumberCollidingList(str.split("\n"));

  if (lines.length === 1) {
    return [
      new Paragraph({
        spacing: SEGMENT_SPACING,
        children: [
          new TextRun({ text: labelText, bold: !!cleanLabel && bold }),
          new TextRun({ text: lines[0] }),
        ],
      }),
    ];
  }

  // Multi-line: the label gets its own paragraph (no spacing of its own --
  // it introduces the lines right below, not a separate segment on its
  // own), then every line, including the first, is its own paragraph; only
  // the last carries SEGMENT_SPACING.
  const paragraphs = [];
  if (labelText) {
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: labelText, bold })] }));
  }
  lines.forEach((line, i) => {
    paragraphs.push(new Paragraph({ text: line, spacing: i === lines.length - 1 ? SEGMENT_SPACING : undefined }));
  });
  return paragraphs;
};

const plain = (text) =>
  new Paragraph({ text: text != null && text !== "" ? String(text) : "（未填写）", spacing: SEGMENT_SPACING });

// A pure section-label line -- unlike p(), which always follows a label with
// either a real value or "（未填写）". Used for a schema-driven lesson's own
// "课时N："/"第N课时：" marker (see buildLessonDesignTrailingChildren), which
// is a section heading in the source template, not a `label: value` field.
// `style` is the marker run's own captured formatting (see templateParser.js
// #extractRuns/markerStyle) for a non-heading marker -- reproduces the
// template's real font size/color/italic/underline/font-family instead of
// normalizing it down to bold-or-not.
const labelOnly = (text, bold = true, style) =>
  new Paragraph({
    spacing: SEGMENT_SPACING,
    children: [
      new TextRun({
        text,
        bold,
        size: style && style.size ? style.size : undefined,
        color: style && style.color ? style.color : undefined,
        italics: style && style.italic ? true : undefined,
        underline: style && style.underline ? {} : undefined,
        font: style && style.font ? style.font : undefined,
      }),
    ],
  });

// A field that can legitimately hold multiple lines (a 课时's own design
// content) -- unlike `p`/`plain`, which show one "（未填写）" line for
// anything falsy, this only does that for a genuinely empty field; a
// filled-in one keeps its line breaks as separate paragraphs. Only the last
// line gets SEGMENT_SPACING -- the field's own internal line breaks are one
// logic segment, not one-per-line, so they stay tight against each other and
// only the gap after the whole field is added.
const multiline = (text) => {
  const str = text != null ? String(text) : "";
  if (str.trim() === "") return [plain("")];
  const lines = str.split("\n");
  return lines.map((line, i) => new Paragraph({ text: line, spacing: i === lines.length - 1 ? SEGMENT_SPACING : undefined }));
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
    children.push(...p(field.label, values[field.key], field.bold === undefined ? true : field.bold, field.hint));
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
// themeXml: the source template's own word/theme/theme1.xml (see
// templateParser.js#extractThemeXml) -- a modern Word/WPS template's
// styles.xml typically points at *theme-relative* fonts/colors
// (w:asciiTheme="majorHAnsi", w:themeColor="accent1", ...) rather than
// literal values, so externalStyles alone isn't enough once a style
// references the theme. Unlike numbering.xml, docx never emits a theme part
// at all by default (confirmed: no file, no [Content_Types].xml entry, no
// relationship) -- so this splices in not just the file but also the
// Content-Types Override and the document.xml.rels Relationship that
// declare it, both otherwise missing. No-op when the template has none (or
// wasn't uploaded).
async function generateDoc({ docTitle, meta, schema, answers, trailingChildren, stylesXml, numberingXml, themeXml }) {
  const children = [title(docTitle)];
  // "基本信息" itself carries no field of its own (its fields are the dedicated
  // Plan columns passed in as `meta`, not part of `schema` -- see
  // plan.controller.js's metaBold comment) so templateParser.js drops the
  // heading along with them; reproduced here as a plain Heading1 (matching
  // the real 2026 template's own pStyle for it) whenever there's a meta
  // block to introduce, rather than leaving the meta rows floating under no
  // heading at all like before.
  if (meta && meta.length > 0) children.push(h1("基本信息"));
  (meta || []).forEach(([label, value, bold]) => children.push(...p(label, value, bold === undefined ? true : bold)));
  children.push(...buildSchemaChildren(schema, answers));
  if (trailingChildren) children.push(...trailingChildren);

  const doc = new Document(stylesXml ? { externalStyles: stylesXml, sections: [{ children }] } : { sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  if (!numberingXml && !themeXml) return buffer;

  const zip = await JSZip.loadAsync(buffer);
  if (numberingXml) zip.file("word/numbering.xml", numberingXml);

  if (themeXml) {
    zip.file("word/theme/theme1.xml", themeXml);

    const contentTypesPath = "[Content_Types].xml";
    const contentTypes = await zip.file(contentTypesPath).async("string");
    const themeOverride =
      '<Override ContentType="application/vnd.openxmlformats-officedocument.theme+xml" PartName="/word/theme/theme1.xml"/>';
    zip.file(contentTypesPath, contentTypes.replace("</Types>", `${themeOverride}</Types>`));

    const relsPath = "word/_rels/document.xml.rels";
    const rels = await zip.file(relsPath).async("string");
    // A fixed, arbitrary relationship id -- valid per the OPC spec (ids only
    // need to be unique, not sequential) and safe here since docx only ever
    // emits rId1-rId5 for styles/numbering/footnotes/settings/comments.
    const themeRelationship =
      '<Relationship Id="rIdThemeAppended" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>';
    zip.file(relsPath, rels.replace("</Relationships>", `${themeRelationship}</Relationships>`));
  }

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

// Rebuilds one lesson's own "课时N："/"第N课时：" marker text for index n from
// the template's captured marker shape (see templateParser.js#
// splitLessonMarker) -- arabic or Chinese-numeral, whichever the source
// template itself used, rather than assuming either.
const renderMarkerLabel = (marker, n) => `${marker.before}${marker.numeralStyle === "arabic" ? n : lessonOrdinal(n)}${marker.after}`;

const buildLessonDesignTrailingChildren = (plan) => {
  const lessons = Array.isArray(plan.planFormData && plan.planFormData.lessons) ? plan.planFormData.lessons : [];
  const lessonCount = plan.plannedLessonCount || lessons.length || 0;
  const schema = plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson;
  const heading = (schema && schema.lessonBreakdownLabel) || DEFAULT_LESSON_BREAKDOWN_LABEL;
  const lessonSchema = schema && schema.lessonSchema;
  const children = [h1(heading)];
  if (lessonCount > 0) {
    for (let i = 1; i <= lessonCount; i += 1) {
      const lesson = lessons.find((l) => Number(l.index) === i) || {};
      if (lessonSchema) {
        // Schema-driven: a reusable per-课时 field template extracted from
        // the source template itself (see templateParser.js#
        // extractLessonSchema) -- applied once per lesson index, the same
        // "one schema, many instances" convention 实施记录 already uses.
        const label = renderMarkerLabel(lessonSchema.marker, i);
        children.push(
          lessonSchema.markerIsHeading ? h2(label) : labelOnly(label, lessonSchema.markerBold, lessonSchema.markerStyle)
        );
        children.push(...buildFieldChildren(lessonSchema.fields, lesson));
        lessonSchema.subsections.forEach((sub) => children.push(...renderSectionTree(sub, 3, lesson)));
      } else {
        // Freeform fallback -- every template that has no detectable
        // repeating 课时-marker pattern (or was parsed before this existed).
        // Plain bold-label paragraph, not a heading -- the real template has
        // no heading style on "第一课时：" (confirmed: no w:pStyle, just a bold
        // run), matching every other field label's shape (see p()) rather
        // than inventing a heading level that isn't in the source.
        children.push(...p(`第${lessonOrdinal(i)}课时`, lesson.title));
        children.push(...multiline(lesson.content));
      }
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
