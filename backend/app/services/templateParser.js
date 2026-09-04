// Best-effort structure discovery from an admin-uploaded reference .docx --
// a genuinely different, harder problem than the existing value-extraction
// in planDocExtract.js (which searches a *filled-in* submission for
// already-known labels). Here the labels themselves are unknown, and the
// document is *blank* (a pristine template has no filled-in content to use
// as a boundary signal between a label and its answer), so there is no
// generic reliable way to tell a section-header apart from a real field --
// both are just short standalone text with nothing after them. See the
// dynamic-templates plan's "Reality check" section for what was actually
// inspected in the two real templates before settling on this heuristic.
//
// Reads word/document.xml directly via `unzip -p` (same pattern
// review.controller.js already uses for .pptx slide XML -- no new
// dependency) rather than mammoth, since this needs raw run-level
// bold/table structure mammoth's plain-text/HTML output doesn't expose.
//
// Result shape (always one flat section, no sub-groups -- see the plan):
//   { sections: [ { key: "main", label: "字段", fields: [ { key: "f0", label, group: null }, ... ] } ] }
const childProcess = require("child_process");

const MAX_LABEL_CHARS = 30;

const readDocumentXml = (filePath) => {
  try {
    return childProcess
      .execFileSync("unzip", ["-p", filePath, "word/document.xml"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8");
  } catch (e) {
    throw new Error("无法读取该 .docx 文件，请确认文件未损坏。");
  }
};

// Runs inside one <w:r>...</w:r> XML chunk: joined <w:t> text + whether its
// <w:rPr> marks it bold. A label can be split across adjacent runs by
// Word's own revision tracking even with no visible formatting difference
// (confirmed on the real 课时实施记录模板.docx -- "观察和反思" arrives as two
// separate runs) -- mergeAdjacentRuns below re-joins those before anything
// else looks at run text, so that artifact never leaks into the result.
const extractRuns = (chunk) => {
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  const runs = [];
  let m;
  while ((m = runRe.exec(chunk))) {
    const runXml = m[1];
    const text = [...runXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("");
    if (!text) continue;
    const bold = /<w:b\s*\/>|<w:b\s+[^>]*\/>/.test(runXml);
    runs.push({ text, bold });
  }
  return runs;
};

const mergeAdjacentRuns = (runs) => {
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.bold === r.bold) {
      last.text += r.text;
    } else {
      merged.push({ text: r.text, bold: r.bold });
    }
  }
  return merged;
};

const isLabelCandidate = (text) => {
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_LABEL_CHARS;
};

// Table-shaped template (the plan design template's real shape): every
// field label observed is a bold run inside a table cell -- walk each row,
// merge adjacent same-bold runs, and every merged bold run of reasonable
// length becomes one field, in document order. A row commonly holds more
// than one field (e.g. a whole WHY row: "WHY", "学习目标", then its 4 real
// fields all bold) -- including the section-marker-looking ones ("WHY") is
// an accepted false positive of "fully automatic, no review", not a bug.
const parseTableFields = (xml) => {
  const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  const labels = [];
  let m;
  while ((m = rowRe.exec(xml))) {
    const runs = mergeAdjacentRuns(extractRuns(m[1]));
    for (const r of runs) {
      if (r.bold && isLabelCandidate(r.text)) labels.push(r.text.trim());
    }
  }
  return labels;
};

// Flat/non-table template (the lesson execution template's real shape): no
// bold used at all there, so the signal is paragraph-level instead --
// every non-empty paragraph is a label candidate except the document's very
// first one (treated as the template's own title, matching both real
// templates' actual first line) and anything longer than MAX_LABEL_CHARS
// (treated as instructional text).
const parseFlatFields = (xml) => {
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  const labels = [];
  let m;
  let seenFirstNonEmpty = false;
  while ((m = paraRe.exec(xml))) {
    const runs = extractRuns(m[1]);
    const text = runs.map((r) => r.text).join("").trim();
    if (!text) continue;
    if (!seenFirstNonEmpty) {
      seenFirstNonEmpty = true; // template title -- skip
      continue;
    }
    if (isLabelCandidate(text)) labels.push(text);
  }
  return labels;
};

// filePath: local path to the uploaded .docx (multer disk storage already
// gives the controller one). Throws on an unreadable file or a parse that
// finds zero fields -- the only safety net in a review-less flow (see
// template.controller.js#upload).
const parseTemplateDocx = (filePath) => {
  const xml = readDocumentXml(filePath);
  const hasTable = /<w:tbl>/.test(xml);
  const labels = hasTable ? parseTableFields(xml) : parseFlatFields(xml);
  if (labels.length === 0) {
    throw new Error("未能从该文件中识别出任何字段，请确认文件包含加粗的字段标签或按行分隔的字段列表。");
  }
  const fields = labels.map((label, i) => ({ key: `f${i}`, label, group: null }));
  return { sections: [{ key: "main", label: "字段", fields }] };
};

module.exports = { parseTemplateDocx };
