import { PLAN_GRADES } from "../constants/plan-options";

// Shared by plans-list.component.js (seeding a brand-new plan from an
// uploaded .docx) and plan-detail.component.js (the 课程设计文件 panel's 上传
// command, which overrides an existing plan's online content the same way).

export const UPLOAD_FIELD_LABELS = {
  title: "标题",
  grade: "年级",
  studentCount: "学生人数",
  instructorName: "执教人",
  plannedLessonCount: "预计课时",
  theme: "乡土主题",
};

const GRADE_DIGIT_TO_LABEL = {
  "1": "一年级", "2": "二年级", "3": "三年级", "4": "四年级", "5": "五年级", "6": "六年级",
  "一": "一年级", "二": "二年级", "三": "三年级", "四": "四年级", "五": "五年级", "六": "六年级",
};

// Best-effort field extraction against curriculum_template/乡土课程设计方案模版.docx's
// labeled header (课程名称/任教年级/学生人数/执教人/预计课时 -- 年份 isn't labeled
// in the template at all, so it's never guessed, only ever filled in by hand).
// 乡土主题 is labeled in some template versions but not others (added in a
// later upload -- see templateParser.js's isAppendixMarker for the separate,
// older 附件-derived *options* list), so result.theme is only ever the raw
// matched text here; the caller (plan-detail.component.js's handleUploadFile)
// still has to validate it against that plan's actual themeOptions before
// applying it, since an older upload's raw text may not match any current
// option, or the label may be entirely absent.
export const extractPlanFieldsFromText = (text) => {
  const result = {};

  // [ \t]* rather than \s* after the colon -- \s* also matches a newline, so a
  // field left completely blank (just "课程名称：" with nothing else on the
  // line) would otherwise have its regex spill across the paragraph break and
  // capture the next line's label ("任教年级：") as this field's value.
  const titleMatch = text.match(/课程名称[：:][ \t]*([^\n]+)/);
  if (titleMatch && titleMatch[1].trim()) result.title = titleMatch[1].trim();

  const gradeMatch = text.match(/任教年级[：:][ \t]*([^\n]+)/);
  if (gradeMatch) {
    const raw = gradeMatch[1];
    // Real submissions don't always spell the grade out as "五年级" -- e.g.
    // "小学5—6年" -- so fall back to mapping a bare digit/Chinese numeral to
    // its PLAN_GRADES label (first one found, for a range like "5—6年").
    const found = PLAN_GRADES.find((g) => raw.includes(g)) || GRADE_DIGIT_TO_LABEL[(raw.match(/[1-6一二三四五六]/) || [])[0]];
    if (found) result.grade = found;
  }

  const studentCountMatch = text.match(/学生人数[：:]\s*(\d+)/);
  if (studentCountMatch) result.studentCount = studentCountMatch[1];

  const instructorMatch = text.match(/执教人[：:][ \t]*([^\n]+)/);
  if (instructorMatch && instructorMatch[1].trim()) result.instructorName = instructorMatch[1].trim();

  const themeMatch = text.match(/乡土主题[：:][ \t]*([^\n]+)/);
  if (themeMatch && themeMatch[1].trim()) result.theme = themeMatch[1].trim();

  const lessonMatch = text.match(/预计课时[：:]\s*(\d+)/);
  if (lessonMatch) result.plannedLessonCount = lessonMatch[1];

  return result;
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches a label at the start of a paragraph line, optionally preceded by the
// template's own numbering ("2.驱动问题", "4公开展示方式") -- anchoring to a line
// start (not "anywhere in the text") is what lets this tell an actual field
// heading apart from the same words showing up mid-sentence in someone's answer
// (e.g. a real submission's 知识探究 content included the prose "...师生共创驱动
// 问题、确定最终成果..." -- an unanchored search would mistake that for the
// what.drivingQuestion heading and steal its neighbor's content). Also matches a
// label wrapped across a line break by Word/mammoth (a real submission had
// "反思与迭代" split into two paragraphs, "反思" then "与迭代") since \s* between
// each of the label's characters absorbs the newline. Returns the matched span
// (idx + length), not just label.length, since a wrapped/prefixed match is
// longer than the label itself.
const findLabel = (text, label) => {
  const pattern = label.split("").map(escapeRegExp).join("\\s*");
  const m = text.match(new RegExp(`^[\\d.．\\s]{0,6}(${pattern})`, "m"));
  if (!m) return null;
  return { idx: m.index + m[0].indexOf(m[1]), length: m[1].length };
};

// Section/sub-section headings that aren't fields themselves but mark hard
// content boundaries, used only as a fallback when the upload isn't shaped like
// the template's table (see extractSectionsFromText) and there's no row/cell
// structure to bound content instead. Both "第二部分：分课时设计" and bare
// "分课时设计" are listed -- older template versions heading the lesson
// breakdown with the "第二部分：" prefix, a newer one (see extractLessonsFromText's
// same 第二部分-optional handling) dropping it -- since findLabel only matches
// a label at its own line start, listing both is safe: whichever a real
// upload doesn't use simply never matches, and the two can never both match
// (one's a superset of the other's line, not the same line). Without a
// matching boundary, the field right before this heading (复盘反思, in every
// template seen so far) had no stopping point and silently absorbed the
// entire 分课时设计 section into its own value (confirmed bug on a newer
// template's upload).
const HARD_SECTION_BOUNDARIES = [
  "WHY",
  "WHAT",
  "HOW",
  "活动设计",
  "探究与制作",
  "三、出项",
  "第二部分：分课时设计",
  "分课时设计",
];

// Finds every known label's position within one block of text (in document
// order, not list order) and takes each field's content as the text up to
// whichever position comes next -- boundaryLabels (if any) are extra stop
// points that cap content but never become a field's own value, for callers
// with no other way to bound a field whose neighbor is missing or empty.
// fieldLabels is a [path, label] pairs array, built from a template's
// schema by extractSectionsFromText below -- generic so this same
// position-based extraction works for both a table-shaped schema (the
// plan_design seed) and a flat one (lesson_execution, or any future
// auto-parsed template).
const extractFieldsFromBlock = (text, fieldLabels, boundaryLabels = []) => {
  const fieldPositions = fieldLabels.map(([path, label]) => ({ path, ...findLabel(text, label) })).filter(
    (p) => p.idx != null
  );
  const boundaryPositions = boundaryLabels
    .map((label) => findLabel(text, label))
    .filter(Boolean)
    .map((m) => ({ path: null, ...m }));
  const positions = [...fieldPositions, ...boundaryPositions].sort((a, b) => a.idx - b.idx);

  const result = {};
  positions.forEach((p, i) => {
    if (!p.path) return;
    const contentStart = p.idx + p.length;
    const contentEnd = i + 1 < positions.length ? positions[i + 1].idx : text.length;
    let content = text.slice(contentStart, contentEnd);
    content = content.replace(/^[（(][^）)]*[）)]/, ""); // e.g. trailing "（为什么做这个乡土主题？）" right after a label
    content = content.replace(/^[：:]/, "");
    // Strip stray leading whitespace/bullets/tab/ideographic-comma noise, but not a
    // leading "1."/"1)" -- a real multi-item answer (e.g. cognitiveGoals' "1. .../2.
    // .../3. ...") needs its first item's number kept, since only the first item
    // sits right after the label match and would otherwise be the one item silently
    // missing its number while every later "2."/"3." in the same block stays intact.
    content = content.replace(/^[\s•·\t、]+/, "");
    content = content.trim();
    if (content) result[p.path] = content;
  });
  return result;
};

// Splits mammoth's table HTML into one flattened text block per <tr>, cell by
// cell, paragraph by paragraph -- i.e. the same per-paragraph text
// extractRawText would produce, just grouped by which table row each paragraph
// physically belongs to. Returns null if there's no table to find (e.g. an
// upload that isn't shaped like the template at all), so callers can fall back
// to treating the whole document as one block.
const tableRowTexts = (html) => {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  const cellText = (cell) => {
    const paras = Array.from(cell.querySelectorAll(":scope > p, :scope > ul > li, :scope > ol > li"));
    return (paras.length ? paras.map((p) => p.textContent || "") : [cell.textContent || ""]).join("\n");
  };
  return Array.from(table.querySelectorAll("tr")).map((tr) => Array.from(tr.querySelectorAll("td, th")).map(cellText).join("\n"));
};

// Best-effort extraction of a template_versions schema's answers from an
// uploaded .docx believed to be a filled-in copy of that same template --
// the generic engine behind both plan_design (multi-section, table-shaped)
// and lesson_execution (single-section, flat) uploads, replacing what used
// to be two separate hand-written functions (extractWhyWhatHowFromText,
// extractExecutionRecordFromText) each hardcoding their own field-label
// list. `schema` is a template_versions row's schemaJson (see
// backend/app/services/templateParser.js / schema.sql's seed versions):
// { sections: [ { key, label, fields: [ { key, label, group } ] } ] }.
//
// Field paths passed to extractFieldsFromBlock are "sectionKey.fieldKey"
// when there's more than one section (so buildAnswersFromExtracted below
// can re-nest results the same way plan.planFormData is already shaped --
// { why: {...}, what: {...}, how: {...} }), or just the bare fieldKey for a
// single-section schema (matching one 实施记录 entry's existing flat shape).
//
// Table-vs-flat handling mirrors the old table-aware function exactly (see
// its retained reasoning below): a table -> extract per row (a row is by
// construction a field boundary); no table -> the old whole-document
// HARD_SECTION_BOUNDARIES fallback. A single-section, non-table schema
// (lesson_execution) always takes the no-table path, same as before.
export const extractSectionsFromText = (text, html, schema) => {
  const sections = (schema && schema.sections) || [];
  const multiSection = sections.length > 1;
  const fieldLabels = [];
  sections.forEach((section) => {
    (section.fields || []).forEach((field) => {
      const path = multiSection ? `${section.key}.${field.key}` : field.key;
      fieldLabels.push([path, field.label]);
    });
  });

  const rowTexts = html && tableRowTexts(html);
  let extracted;
  if (rowTexts && rowTexts.length) {
    extracted = {};
    for (const rowText of rowTexts) {
      const rowResult = extractFieldsFromBlock(rowText, fieldLabels);
      for (const [path, value] of Object.entries(rowResult)) {
        if (!(path in extracted)) extracted[path] = value;
      }
    }
  } else {
    extracted = extractFieldsFromBlock(text, fieldLabels, HARD_SECTION_BOUNDARIES);
  }
  return buildAnswersFromExtracted(schema, extracted);
};

// Re-nests extractSectionsFromText's flat { path: value } result back into
// the plan's actual stored-answer shape: { sectionKey: { fieldKey: value } }
// for a multi-section schema (plan_design), or a flat { fieldKey: value }
// object for a single-section one (lesson_execution) -- see
// dynamicDocGenerator.js's sectionAnswers, which reads answers the same way.
export const buildAnswersFromExtracted = (schema, extracted) => {
  const sections = (schema && schema.sections) || [];
  if (sections.length <= 1) return { ...extracted };
  const data = {};
  sections.forEach((section) => {
    data[section.key] = {};
  });
  Object.entries(extracted).forEach(([path, value]) => {
    const [sectionKey, fieldKey] = path.split(".");
    if (data[sectionKey]) data[sectionKey][fieldKey] = value;
  });
  return data;
};

// True if extractSectionsFromText/buildAnswersFromExtracted's output (or any
// answers object shaped like it) has at least one non-empty field, across
// however many sections the schema has -- used to decide whether an upload
// actually matched anything before overwriting a plan's/课时's content with
// it (see plan-detail.component.js's 上传 handlers).
export const hasAnySectionContent = (schema, answers) => {
  const sections = (schema && schema.sections) || [];
  const hasValue = (obj) => Object.values(obj || {}).some((v) => v != null && String(v).trim() !== "");
  if (sections.length > 1) return sections.some((s) => hasValue(answers && answers[s.key]));
  return hasValue(answers);
};

// Leading-whitespace class used by the Part 2 regexes below (not \s -- \s also
// matches a newline, which would let e.g. "第一课时：" with nothing else on the
// line swallow the blank line after it and capture the *next* heading as this
// one's inline title, the same class of bug findLabel had to avoid for Part 1's
// labels). A real submission's lesson headings are inconsistently indented --
// some with a couple of regular spaces, one with a literal U+00A0 non-breaking
// space -- so this covers ordinary spaces/tabs plus the common Unicode space
// variants, not just " ".
const PART2_LEADING_WS = "[ \\t\\u00a0\\u2000-\\u200a\\u3000]*";
// "第二部分：" is optional -- a newer template heads this section with bare
// "分课时设计" (no part number/colon at all), confirmed on a real upload that
// otherwise lost its entire lesson breakdown (see HARD_SECTION_BOUNDARIES'
// same 第二部分-optional handling for extractFieldsFromBlock's boundary use).
const PART2_HEADING_RE = new RegExp(`^${PART2_LEADING_WS}(?:第二部分[：:]?${PART2_LEADING_WS})?分课时设计`, "m");
// Each lesson heading is either "第N课时" (older templates) or "课时N" (a
// newer one, number after the word instead of before) -- same confirmed-bug
// upload as above had "课时1："/"课时2："/... which the "第N课时"-only pattern
// never matched, so no lesson headings were found at all even once
// PART2_HEADING_RE above was fixed to find the section itself.
const LESSON_HEADING_RE = new RegExp(
  `^${PART2_LEADING_WS}(?:第[0-9一二三四五六七八九十百]+课时|课时[0-9一二三四五六七八九十百]+)[：:]?${PART2_LEADING_WS}([^\\n]*)`,
  "gm"
);
const PART3_HEADING_RE = new RegExp(`^${PART2_LEADING_WS}第三部分`, "m");

// Best-effort extraction of "第二部分：分课时设计" into the same
// [{ index, title, content }] shape dynamicDocGenerator.js's caller renders it
// from (see EMPTY_LESSON). This section lives entirely outside the template's
// table (see extractSectionsFromText's table-row approach for the field
// sections), as a flat run of
// paragraphs with no structure of its own beyond the "第N课时：" headings
// themselves, so it's handled independently over the whole flattened text
// rather than through tableRowTexts. Each "第N课时" heading may carry an inline
// title on the same line (e.g. "第1课时：入项激趣——认识一种...的米饼"); the
// i-th heading found becomes lesson i, by position rather than by parsing the
// heading's own numeral (Arabic and Chinese numerals are both used across the
// template/real submissions, and document order is always sequential in
// practice, so trusting position sidesteps numeral-parsing edge cases
// entirely). Content runs from right after one heading to the next, capped at
// "第三部分" for the last lesson if present (otherwise end of document) so it
// doesn't swallow the materials/resources section that can follow.
//
// lessonSchema (optional, a template_versions row's schemaJson.lessonSchema
// -- see templateParser.js#extractLessonSchema) is what plan-detail.component.js's
// planLesson pane actually reads once a template has one: DynamicSectionFields
// there renders one input per lessonSchema.fields entry and looks up each
// value by that field's own key (f0, f1, ...) directly on the lesson object,
// never touching title/content at all in that branch (see EMPTY_LESSON's
// comment there). Without this, an upload against such a template extracted
// each lesson's heading/content correctly but the content sat in `content`
// where nothing read it -- confirmed bug: 分课时设计 content stopped bleeding
// into the previous field (the earlier fix) but then didn't show up
// anywhere either. When lessonSchema is given, each lesson's own field
// values are extracted from its content block the same generic way
// extractSectionsFromText extracts a table row's fields, and merged in
// alongside title/content (harmless when a schema-driven template falls back
// to the freeform UI, and vice versa -- each branch only reads its own keys).
export const extractLessonsFromText = (text, lessonSchema) => {
  const part2Idx = text.search(PART2_HEADING_RE);
  if (part2Idx === -1) return [];
  const part2Text = text.slice(part2Idx);
  const matches = [...part2Text.matchAll(LESSON_HEADING_RE)];
  if (matches.length === 0) return [];
  const part3Idx = part2Text.search(PART3_HEADING_RE);
  const end = part3Idx === -1 ? part2Text.length : part3Idx;
  const lessonFieldLabels =
    lessonSchema && lessonSchema.fields ? lessonSchema.fields.map((f) => [f.key, f.label]) : null;

  return matches
    .map((m, i) => {
      const contentStart = m.index + m[0].length;
      const contentEnd = i + 1 < matches.length ? matches[i + 1].index : end;
      if (contentEnd <= m.index) return null;
      const title = (m[1] || "").trim();
      const content = part2Text.slice(contentStart, contentEnd).trim();
      const fieldValues = lessonFieldLabels && lessonFieldLabels.length ? extractFieldsFromBlock(content, lessonFieldLabels) : {};
      return { index: i + 1, title, content, ...fieldValues };
    })
    .filter((l) => l && (l.title || l.content));
};
