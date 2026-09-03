import {
  PLAN_GRADES,
  EMPTY_WHY_WHAT_HOW,
  WHY_WHAT_HOW_FIELD_LABELS,
  EMPTY_EXECUTION_RECORD,
  EXECUTION_RECORD_FIELD_LABELS,
} from "../constants/plan-options";

// Shared by plans-list.component.js (seeding a brand-new plan from an
// uploaded .docx) and plan-detail.component.js (the 课程设计文件 panel's 上传
// command, which overrides an existing plan's online content the same way).

export const UPLOAD_FIELD_LABELS = { title: "标题", grade: "年级", plannedLessonCount: "预计课时" };

const GRADE_DIGIT_TO_LABEL = {
  "1": "一年级", "2": "二年级", "3": "三年级", "4": "四年级", "5": "五年级", "6": "六年级",
  "一": "一年级", "二": "二年级", "三": "三年级", "四": "四年级", "五": "五年级", "六": "六年级",
};

// Best-effort field extraction against curriculum_template/乡土课程设计方案模版.docx's
// labeled header (课程名称/任教年级/预计课时 -- 乡土主题 和 年份 aren't labeled in
// the template at all, so those are never guessed, only ever filled in by hand).
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
// the template's table (see extractWhyWhatHowFromText) and there's no row/cell
// structure to bound content instead.
const HARD_SECTION_BOUNDARIES = ["WHY", "WHAT", "HOW", "活动设计", "探究与制作", "三、出项", "第二部分：分课时设计"];

// Finds every known label's position within one block of text (in document
// order, not list order) and takes each field's content as the text up to
// whichever position comes next -- boundaryLabels (if any) are extra stop
// points that cap content but never become a field's own value, for callers
// with no other way to bound a field whose neighbor is missing or empty.
// fieldLabels is a [path, label] pairs array (WHY_WHAT_HOW_FIELD_LABELS or
// EXECUTION_RECORD_FIELD_LABELS) -- generalized so this same position-based
// extraction works for both the plan's table-shaped template and the
// 实施记录 template's flat one.
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

// Best-effort extraction of the WHY/WHAT/HOW body into the same shape the
// online-fill form uses (EMPTY_WHY_WHAT_HOW), so an uploaded plan renders
// through the same section-by-section presentation as one filled in online,
// not just an attached file.
//
// The template (curriculum_template/乡土课程设计方案模版.docx) is a single table,
// one field (or a handful of related fields) per row, and real submissions keep
// that same row layout since authors type directly into the template's cells.
// So rather than pattern-matching over the entire document flattened into one
// string, this processes each table row as its own independent block (see
// tableRowTexts) -- a table row is *by construction* the field boundary the old
// flat-text approach had to fake with a hardcoded HARD_SECTION_BOUNDARIES list
// (a field can only ever swallow noise from within its own row/cell now, never
// bleed into an unrelated section several rows away just because its neighbor
// label was missing or left empty). A real filled-in document still mixes two
// styles within a row -- "标签：内容" inline (WHY's四goals) and "标题\n内容段落"
// (HOW's activities) -- extractFieldsFromBlock's position-based boundary works
// for both uniformly. Falls back to the old whole-document/HARD_SECTION_BOUNDARIES
// approach if mammoth can't find a table at all. Fields whose label isn't found
// are left blank rather than guessed; if the same field label were somehow
// matched in more than one row, the first (in document order) wins.
export const extractWhyWhatHowFromText = (text, html) => {
  const rowTexts = html && tableRowTexts(html);
  if (!rowTexts || !rowTexts.length) return extractFieldsFromBlock(text, WHY_WHAT_HOW_FIELD_LABELS, HARD_SECTION_BOUNDARIES);

  const result = {};
  for (const rowText of rowTexts) {
    const rowResult = extractFieldsFromBlock(rowText, WHY_WHAT_HOW_FIELD_LABELS);
    for (const [path, value] of Object.entries(rowResult)) {
      if (!(path in result)) result[path] = value;
    }
  }
  return result;
};

export const buildPlanFormData = (extracted, lessons) => {
  const data = { why: { ...EMPTY_WHY_WHAT_HOW.why }, what: { ...EMPTY_WHY_WHAT_HOW.what }, how: { ...EMPTY_WHY_WHAT_HOW.how }, lessons: lessons || [] };
  for (const [path, value] of Object.entries(extracted)) {
    const [section, field] = path.split(".");
    data[section][field] = value;
  }
  return data;
};

// curriculum_template/课时实施记录模板.docx is a flat run of labeled
// paragraphs with no table at all (unlike the plan's template), so this is
// just extractFieldsFromBlock over the whole document -- no
// tableRowTexts/HARD_SECTION_BOUNDARIES fallback dance needed, and no
// section nesting in the resulting paths (EXECUTION_RECORD_FIELD_LABELS'
// paths are bare field names, not "section.field").
export const extractExecutionRecordFromText = (text) => extractFieldsFromBlock(text, EXECUTION_RECORD_FIELD_LABELS);

export const buildExecutionRecordData = (extracted) => ({ ...EMPTY_EXECUTION_RECORD, ...extracted });

// Leading-whitespace class used by the Part 2 regexes below (not \s -- \s also
// matches a newline, which would let e.g. "第一课时：" with nothing else on the
// line swallow the blank line after it and capture the *next* heading as this
// one's inline title, the same class of bug findLabel had to avoid for Part 1's
// labels). A real submission's lesson headings are inconsistently indented --
// some with a couple of regular spaces, one with a literal U+00A0 non-breaking
// space -- so this covers ordinary spaces/tabs plus the common Unicode space
// variants, not just " ".
const PART2_LEADING_WS = "[ \\t\\u00a0\\u2000-\\u200a\\u3000]*";
const PART2_HEADING_RE = new RegExp(`^${PART2_LEADING_WS}第二部分[：:]?${PART2_LEADING_WS}分课时设计`, "m");
const LESSON_HEADING_RE = new RegExp(`^${PART2_LEADING_WS}第[0-9一二三四五六七八九十百]+课时[：:]?${PART2_LEADING_WS}([^\\n]*)`, "gm");
const PART3_HEADING_RE = new RegExp(`^${PART2_LEADING_WS}第三部分`, "m");

// Best-effort extraction of "第二部分：分课时设计" into the same
// [{ index, title, content }] shape planDocGenerator.js renders it from (see
// EMPTY_LESSON). This section lives entirely outside the template's table (see
// extractWhyWhatHowFromText's table-row approach for Part 1), as a flat run of
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
export const extractLessonsFromText = (text) => {
  const part2Idx = text.search(PART2_HEADING_RE);
  if (part2Idx === -1) return [];
  const part2Text = text.slice(part2Idx);
  const matches = [...part2Text.matchAll(LESSON_HEADING_RE)];
  if (matches.length === 0) return [];
  const part3Idx = part2Text.search(PART3_HEADING_RE);
  const end = part3Idx === -1 ? part2Text.length : part3Idx;

  return matches
    .map((m, i) => {
      const contentStart = m.index + m[0].length;
      const contentEnd = i + 1 < matches.length ? matches[i + 1].index : end;
      if (contentEnd <= m.index) return null;
      const title = (m[1] || "").trim();
      const content = part2Text.slice(contentStart, contentEnd).trim();
      return { index: i + 1, title, content };
    })
    .filter((l) => l && (l.title || l.content));
};
