// Best-effort structure discovery from an admin-uploaded reference .docx --
// a genuinely different, harder problem than the existing value-extraction
// in planDocExtract.js (which searches a *filled-in* submission for
// already-known labels). Here the labels themselves are unknown, and the
// document is *blank* (a pristine template has no filled-in content to use
// as a boundary signal between a label and its answer), so there is no
// generic reliable way to tell a section-header apart from a real field --
// both are just short standalone text with nothing after them. See the
// dynamic-templates plan's "Reality check" section for what was actually
// inspected in the two real templates before settling on the table/flat
// heuristics below, and the layered-template-metadata plan for the heading-
// style-aware parser added on top of them.
//
// Reads word/document.xml (and, for the heading-aware parser, word/styles.xml)
// directly via `unzip -p` (same pattern review.controller.js already uses
// for .pptx slide XML -- no new dependency) rather than mammoth, since this
// needs raw run-level bold/style structure mammoth's plain-text/HTML output
// doesn't expose.
//
// Three shapes can come out of parseTemplateDocx, tried in this order:
//   1. Table-shaped (a <w:tbl> is present): unchanged from the original
//      ad-hoc heuristic -- one flat section, bold table-cell runs as fields.
//   2. Heading-styled (no table, but paragraphs use real Word heading
//      styles -- Heading1..Heading9, resolved generically via styles.xml
//      rather than hardcoded styleId strings): a true nested outline is
//      built (see parseHeadingSections), then flattened into each top-level
//      section's `fields` (with a `group` label) for backward compatibility
//      with every existing flat-shape consumer, alongside the true
//      `subsections` tree for consumers that want the real hierarchy.
//   3. Flat/no-heading fallback: unchanged from the original ad-hoc
//      heuristic -- every non-empty paragraph except the title is a field.
const childProcess = require("child_process");
const fs = require("fs");

const MAX_LABEL_CHARS = 30;
const NO_FIELDS_ERROR = "未能从该文件中识别出任何字段，请确认文件包含加粗的字段标签或按行分隔的字段列表。";

const readDocumentXml = (filePath) => {
  try {
    return childProcess
      .execFileSync("unzip", ["-p", filePath, "word/document.xml"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8");
  } catch (e) {
    throw new Error("无法读取该 .docx 文件，请确认文件未损坏。");
  }
};

// Styling/heading-structure metadata is a bonus on top of field discovery,
// never a reason to fail the whole parse -- returns null on any problem
// (missing entry, corrupt zip, etc.) rather than throwing.
const readStylesXml = (filePath) => {
  try {
    return childProcess
      .execFileSync("unzip", ["-p", filePath, "word/styles.xml"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8");
  } catch (e) {
    return null;
  }
};

// A heading style's real multi-level numbering ("2.1", with each level's own
// indentation) lives in word/numbering.xml, not styles.xml -- a heading
// style's <w:numPr><w:numId .../></w:numPr> is just a reference into it (see
// the real 2026 template's Heading1..4 styles). Same non-throwing contract
// as readStylesXml. See dynamicDocGenerator.js#generateDoc's `numberingXml`.
const readNumberingXml = (filePath) => {
  try {
    return childProcess
      .execFileSync("unzip", ["-p", filePath, "word/numbering.xml"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8");
  } catch (e) {
    return null;
  }
};

// A modern Word/WPS template's styles.xml resolves its heading fonts/colors
// through theme references (w:asciiTheme="majorHAnsi", w:themeColor="accent1",
// etc.) rather than literal values -- word/theme/theme1.xml is what those
// resolve against. Same non-throwing contract as readStylesXml/readNumberingXml.
// See dynamicDocGenerator.js#generateDoc's `themeXml`.
const readThemeXml = (filePath) => {
  try {
    return childProcess
      .execFileSync("unzip", ["-p", filePath, "word/theme/theme1.xml"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8");
  } catch (e) {
    return null;
  }
};

// Runs inside one <w:r>...</w:r> XML chunk: joined <w:t> text + whether its
// <w:rPr> marks it bold. A label can be split across adjacent runs by
// Word's own revision tracking even with no visible formatting difference
// (confirmed on the real 课时实施记录模板.docx -- "观察和反思" arrives as two
// separate runs) -- mergeAdjacentRuns below re-joins those before anything
// else looks at run text, so that artifact never leaks into the result.
// size/color/italic/underline/font: only read on demand (see `runStyle`
// below, captured per-field in parseHeadingSections) for reproducing a
// non-heading anchor run's own look (e.g. a plain-paragraph "课时1" marker,
// see extractLessonSchema's markerStyle) -- a heading-styled marker instead
// gets its formatting from the real heading style via externalStyles, so
// this is never needed there.
const extractRuns = (chunk) => {
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  const runs = [];
  let m;
  while ((m = runRe.exec(chunk))) {
    const runXml = m[1];
    const text = [...runXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("");
    if (!text) continue;
    const bold = /<w:b\s*\/>|<w:b\s+[^>]*\/>/.test(runXml);
    const italic = /<w:i\s*\/>|<w:i\s+[^>]*\/>/.test(runXml);
    const underline = /<w:u\s+[^>]*w:val="(?!none)[^"]*"[^>]*\/>/.test(runXml);
    const sizeMatch = runXml.match(/<w:sz\s+w:val="(\d+)"/);
    const size = sizeMatch ? Number(sizeMatch[1]) : null;
    const colorMatch = runXml.match(/<w:color\s+w:val="([0-9A-Fa-f]{6})"/);
    const color = colorMatch ? colorMatch[1] : null;
    const fontsMatch = runXml.match(/<w:rFonts\b([^>]*)\/>/);
    let font = null;
    if (fontsMatch) {
      const eastAsia = fontsMatch[1].match(/w:eastAsia="([^"]+)"/);
      const ascii = fontsMatch[1].match(/w:ascii="([^"]+)"/);
      font = (eastAsia && eastAsia[1]) || (ascii && ascii[1]) || null;
    }
    runs.push({ text, bold, italic, underline, size, color, font });
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

// Canonicalizes a label's own trailing colon to a single width (full-width
// "：") right where it's captured from the template's raw paragraph/run
// text -- the one place both downstream consumers' otherwise-independent
// colon assumptions actually need to agree. dynamicDocGenerator.js#p()/
// labelOnly() already re-derive a canonical full-width colon when RENDERING
// a label (regardless of what's stored), but nothing previously normalized
// the label as EXTRACTION-time schema data itself, and a real template's
// labels aren't consistent about it (confirmed: "探究问题:" (half-width) sat
// right next to "探究方法:" and "讨论须知清单：" (full-width) in the same
// template) -- so a stored label could disagree with the always-canonical
// rendered text, and react-app/src/utils/planDocExtract.js#findLabel (which
// matches a re-uploaded, re-rendered document against the stored label) had
// no way to know that. Normalizing here means the schema itself -- already
// the one piece of data both the renderer and the extractor read -- is the
// single source of truth for colon width, instead of each side re-deriving
// or tolerating its own guess. A label with no colon at all (e.g. a heading
// used as a field, see demoteEmptyHeadings) is left untouched, not given one.
const normalizeLabel = (text) => text.replace(/[:：]\s*$/, "：");

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
      if (r.bold && isLabelCandidate(r.text)) labels.push(normalizeLabel(r.text.trim()));
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
    if (isLabelCandidate(text)) labels.push(normalizeLabel(text));
  }
  return labels;
};

const asFlatSchema = (labels) => ({
  sections: [{ key: "main", label: "字段", fields: labels.map((label, i) => ({ key: `f${i}`, label, group: null })) }],
});

// Resolves each paragraph style's heading depth (1-based, matching Word's
// own "heading 1".."heading 9" naming) from word/styles.xml, generically --
// via the style's declared <w:name> or <w:outlineLvl> rather than hardcoded
// styleId strings like "Heading1", since a real-world .docx's styleIds
// aren't guaranteed to match that literal spelling (confirmed to happen to
// match on the real 2026 template, but nothing about the OOXML format
// requires it).
const buildHeadingLevelMap = (stylesXml) => {
  const map = new Map();
  if (!stylesXml) return map;
  const styleRe = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = styleRe.exec(stylesXml))) {
    const [, styleId, body] = m;
    const nameMatch = body.match(/<w:name\s+w:val="([^"]+)"/);
    const headingNameMatch = nameMatch && nameMatch[1].match(/^heading\s*(\d+)$/i);
    if (headingNameMatch) {
      map.set(styleId, Number(headingNameMatch[1]));
      continue;
    }
    const outlineMatch = body.match(/<w:outlineLvl\s+w:val="(\d+)"/);
    if (outlineMatch) map.set(styleId, Number(outlineMatch[1]) + 1);
  }
  return map;
};

const documentUsesAnyHeadingStyle = (xml, headingLevelMap) => {
  const styleRe = /<w:pStyle\s+w:val="([^"]+)"/g;
  let m;
  while ((m = styleRe.exec(xml))) {
    if (headingLevelMap.has(m[1])) return true;
  }
  return false;
};

// Top-level heading sections that map to something else entirely elsewhere
// in the app, so a heading-based parse must drop them rather than surface
// them a second time as generic schema sections (see the layered-template-
// metadata plan). Modeled after planDocExtract.js's HARD_SECTION_BOUNDARIES
// -- small, literal, and reviewed by hand rather than inferred.
// 课程名称/任教年级/学生人数/执教人/预计课时 -- superseded by the plans table's own
// dedicated columns (title/grade/studentCount/instructorName/
// plannedLessonCount), rendered via dynamicDocGenerator.js's hardcoded
// `meta` list, not the field-schema mechanism.
const isBasicInfoLabel = (label) => label === "基本信息";
// The per-课时 breakdown is freeform per-课时 title+content, rendered via
// dynamicDocGenerator.js#buildLessonDesignTrailingChildren instead of the
// field-schema mechanism -- including it here would render it twice.
const isLessonBreakdownLabel = (label) => label.includes("分课时设计");

// "附件：2026秋季学期乡土主题名称" followed by one label per line -- feeds the
// 乡土主题 dropdown (see plan.controller.js#getOptions), not surfaced
// anywhere else (not a schema section, not rendered into a generated doc).
// Confirmed on the real template to be a *plain* paragraph, not its own
// heading, so it ends up glued onto whatever heading happens to precede it
// in document order (分课时设计, in that template) rather than getting its
// own root.subsections entry -- extractThemeOptionsFromFields below handles
// that shape; isAppendixSectionLabel is kept too for a template that does
// give it a real heading of its own.
const isAppendixMarker = (label) => /^附件[:：]/.test(label.trim());
const isAppendixSectionLabel = (label) => label.trim().startsWith("附件");

// Finds an appendix marker among one node's own direct fields and, if
// present, returns everything after it as the theme option list, removing
// the marker and those trailing entries from node.fields in place (they
// aren't real fields of whatever section they got glued onto).
const extractThemeOptionsFromFields = (node) => {
  const idx = node.fields.findIndex((f) => isAppendixMarker(f.label));
  if (idx === -1) return null;
  const options = node.fields
    .slice(idx + 1)
    .map((f) => f.label.trim())
    .filter(Boolean);
  node.fields = node.fields.slice(0, idx);
  return options.length > 0 ? options : null;
};

// Finds the numeral span in a "分课时设计" instance marker's own text (e.g.
// "课时1：" or "第一课时：") and splits around it -- arabic digits tried first,
// then a run of Chinese numeral characters. Returns null if neither is
// present (not a lesson marker at all). Kept generic rather than hardcoding
// either wording: confirmed the real templates use both, one per template.
const splitLessonMarker = (text) => {
  let m = text.match(/\d+/);
  if (m) return { before: text.slice(0, m.index), numeralStyle: "arabic", after: text.slice(m.index + m[0].length) };
  m = text.match(/[一二三四五六七八九十百千]+/);
  if (m) return { before: text.slice(0, m.index), numeralStyle: "chinese", after: text.slice(m.index + m[0].length) };
  return null;
};
// A genuine lesson marker's *entire* text is "课时N"/"第N课时" plus
// punctuation -- not just any field label that happens to mention "课时"
// somewhere in a longer label (confirmed a real false positive: "1.课时标题：",
// a legitimate per-课时 field meaning "lesson title", also contains "课时"
// plus a leading digit, but is obviously not itself a lesson-boundary
// marker). Stripping the matched numeral and punctuation and requiring what
// remains to be exactly "课时" or "第课时" rules that out generically, without
// hardcoding either template's exact wording.
const isLessonMarkerText = (text) => {
  const marker = splitLessonMarker(text);
  if (!marker) return false;
  const stripped = (marker.before + marker.after).replace(/[.:：\s]/g, "");
  return stripped === "课时" || stripped === "第课时";
};

// Extracts a reusable per-课时 field template from "分课时设计"'s own subtree,
// applied once per actual lesson at generation/online-fill time -- the same
// "one schema, many instances" convention lesson_execution already uses for
// 实施记录 (see dynamicDocGenerator.js#buildLessonDesignTrailingChildren and
// plan-detail.component.js's `executionRecord` branch). 课时N may or may not
// be its own heading -- confirmed to vary: a real Heading2 in one template, a
// plain bold paragraph among 分课时设计's own flat fields in another -- so
// both are detected the same generic way, via isLessonMarkerText, rather
// than assuming either shape. Only the *first* instance is read (every
// instance in a blank template repeats the same field set); returns null
// when no repeating 课时-marker pattern is found at all, so the caller keeps
// the freeform title+content model for that template.
const extractLessonSchema = (node) => {
  const headingInstances = node.subsections.filter((s) => isLessonMarkerText(s.label));
  if (headingInstances.length > 0) {
    const first = headingInstances[0];
    let fieldCounter = 0;
    const assignFieldKeys = (n) => {
      n.fields.forEach((f) => {
        f.key = `f${fieldCounter++}`;
      });
      n.subsections.forEach(assignFieldKeys);
    };
    assignFieldKeys(first);
    return { marker: splitLessonMarker(first.label), markerIsHeading: true, fields: first.fields, subsections: first.subsections };
  }

  const markerIdx = node.fields.findIndex((f) => isLessonMarkerText(f.label));
  if (markerIdx === -1) return null;
  const nextMarkerIdx = node.fields.findIndex((f, i) => i > markerIdx && isLessonMarkerText(f.label));
  const slice = node.fields.slice(markerIdx + 1, nextMarkerIdx === -1 ? undefined : nextMarkerIdx);
  return {
    marker: splitLessonMarker(node.fields[markerIdx].label),
    markerIsHeading: false,
    markerBold: node.fields[markerIdx].bold,
    markerStyle: node.fields[markerIdx].runStyle || null,
    fields: slice.map((f, i) => ({ key: `f${i}`, label: f.label, group: null, bold: f.bold, hint: f.hint || null })),
    subsections: [],
  };
};

// Heading-style-driven structure discovery: walks paragraphs in document
// order, using each one's resolved heading level (via headingLevelMap) to
// build a true nested tree (stack-based -- a heading pops the stack down to
// its own level, then pushes itself as the new deepest node; a non-heading
// paragraph becomes a field on whatever is currently deepest).
const parseHeadingSections = (xml, headingLevelMap) => {
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  const root = { label: null, level: 0, fields: [], subsections: [] };
  const stack = [root];
  let m;
  while ((m = paraRe.exec(xml))) {
    const chunk = m[1];
    const styleMatch = chunk.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const level = styleMatch ? headingLevelMap.get(styleMatch[1]) : undefined;
    const runs = extractRuns(chunk);
    const text = runs.map((r) => r.text).join("").trim();
    if (!text) continue;

    if (level) {
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const node = { label: normalizeLabel(text), level, fields: [], subsections: [] };
      stack[stack.length - 1].subsections.push(node);
      stack.push(node);
      continue;
    }

    if (text.startsWith("-")) {
      // Hint/example text for the *preceding* field's response area, not a
      // field (or any other structural construct) of its own -- e.g.
      // "探究问题:" followed by "-您的驱动问题是：" in the real 2026模板6 template.
      // Folded onto whatever field was pushed most recently within the
      // currently open node (deepest stack entry), joined with "\n" when
      // more than one hint line follows the same field; deliberately not
      // length-capped like isLabelCandidate below since a hint can run
      // longer than a real label ever would. Silently dropped if there's no
      // preceding field in this node yet (e.g. a stray leading dash line) --
      // there's nothing to attach it to, and per the same "not a construct
      // of its own" rule it must not fall through and become a field either.
      const node = stack[stack.length - 1];
      const lastField = node.fields[node.fields.length - 1];
      if (lastField) {
        const hintText = text.replace(/^-\s*/, "");
        lastField.hint = lastField.hint ? `${lastField.hint}\n${hintText}` : hintText;
      }
      continue;
    }

    if (isLabelCandidate(text)) {
      // The real template is inconsistent about which field labels are bold
      // (confirmed on the 2026 template -- e.g. "1.认知思维目标：" is bold,
      // "课程名称：" isn't) -- captured per field here, rather than assuming
      // every label should be bold, so generation can reproduce the
      // template's own choice instead of inventing a blanket style (see
      // dynamicDocGenerator.js#p's `bold` parameter).
      // runStyle: the field's first run's own size/color/italic/underline/
      // font -- only ever consumed for a non-heading 课时-marker field (see
      // extractLessonSchema's markerStyle); harmless to capture for every
      // field since regular fields' output styling comes from the Normal
      // style, not this.
      const firstRun = runs[0];
      stack[stack.length - 1].fields.push({
        label: normalizeLabel(text),
        bold: runs.some((r) => r.bold),
        runStyle: firstRun
          ? { size: firstRun.size, color: firstRun.color, italic: firstRun.italic, underline: firstRun.underline, font: firstRun.font }
          : null,
      });
    }
  }

  // A heading with nothing under it before the next heading of equal-or-
  // higher level is itself the field/prompt, not a section -- e.g. "项目介绍
  // （为什么做这个乡土主题？）" and "公开展示方式" in the real 2026 template have
  // no field paragraph of their own, the heading text *is* the question.
  const demoteEmptyHeadings = (node) => {
    node.subsections = node.subsections.filter((child) => {
      demoteEmptyHeadings(child);
      if (child.fields.length === 0 && child.subsections.length === 0) {
        // Demoted from a heading, not a body paragraph, so there's no run-
        // level bold signal to read -- defaults to bold like the label it
        // stood in for as a heading.
        node.fields.push({ label: child.label, bold: true });
        return false;
      }
      return true;
    });
  };
  demoteEmptyHeadings(root);

  // The lesson-breakdown heading's own wording is captured (not just
  // dropped) so the generic trailing-tail renderer can use the template's
  // actual text -- e.g. "分课时设计" here -- instead of a hardcoded guess like
  // "第二部分：分课时设计", which some other template might phrase differently
  // (or not at all). See dynamicDocGenerator.js#buildLessonDesignTrailingChildren.
  let lessonBreakdownLabel = null;
  let lessonSchema = null;
  // Likewise, 基本信息's own fields (课程名称/任教年级/etc.) are dropped from the
  // schema (superseded by dedicated Plan columns -- see isBasicInfoLabel),
  // but their bold-ness is still captured, keyed by label with the trailing
  // colon stripped, so dynamicDocGenerator.js's hardcoded `meta` rendering
  // can reproduce the template's real choice per field instead of assuming
  // one -- confirmed the real 2026 template leaves "课程名称：" un-bold while
  // bolding other labels elsewhere, so a blanket default would misrepresent it.
  let basicInfoBold = null;
  // 乡土主题 dropdown options (see plan.controller.js#getOptions) -- captured
  // from an "附件" marker wherever it's found among the top-level nodes' own
  // fields (see extractThemeOptionsFromFields), before the exclusion filter
  // below runs, so this works whichever top-level node the marker happened
  // to end up glued onto (分课时设计 on the real template, but not assumed to
  // be there specifically).
  let themeOptions = null;
  root.subsections.forEach((s) => {
    if (themeOptions) return;
    themeOptions = extractThemeOptionsFromFields(s);
  });
  root.subsections = root.subsections.filter((s) => {
    if (isBasicInfoLabel(s.label)) {
      basicInfoBold = {};
      s.fields.forEach((f) => {
        basicInfoBold[f.label.replace(/[:：]\s*$/, "")] = f.bold;
      });
      return false;
    }
    if (isLessonBreakdownLabel(s.label)) {
      lessonBreakdownLabel = s.label;
      lessonSchema = extractLessonSchema(s);
      return false;
    }
    // A template that gives 附件 its own real heading instead of leaving it
    // as trailing plain paragraphs (see extractThemeOptionsFromFields above,
    // which only catches the latter shape) -- every one of its own fields is
    // a theme option, no marker-splitting needed since the whole node is it.
    if (isAppendixSectionLabel(s.label)) {
      if (!themeOptions) {
        const options = s.fields.map((f) => f.label.trim()).filter(Boolean);
        themeOptions = options.length > 0 ? options : null;
      }
      return false;
    }
    return true;
  });
  if (root.subsections.length === 0) return null;

  let fieldCounter = 0;
  let sectionCounter = 0;
  const assignKeys = (node) => {
    node.key = `s${sectionCounter++}`;
    node.fields.forEach((f) => {
      f.key = `f${fieldCounter++}`;
    });
    node.subsections.forEach(assignKeys);
  };
  root.subsections.forEach(assignKeys);

  // Full descendant field list for one top-level node, flattened in document
  // order -- group is the nearest ancestor heading below the top-level node
  // itself (null for a field sitting directly under the top-level heading).
  const collectFields = (node, isTop, out) => {
    const group = isTop ? null : node.label;
    node.fields.forEach((f) => out.push({ key: f.key, label: f.label, group, bold: f.bold, hint: f.hint || null }));
    node.subsections.forEach((child) => collectFields(child, false, out));
  };

  // True nested shape, direct fields/subsections only at each depth --
  // additive; absent from every legacy (table/flat) schema.
  const toSubsectionNode = (node, level) => ({
    key: node.key,
    label: node.label,
    level,
    fields: node.fields.map((f) => ({ key: f.key, label: f.label, group: null, bold: f.bold, hint: f.hint || null })),
    subsections: node.subsections.map((child) => toSubsectionNode(child, level + 1)),
  });

  // Top-level entries carry both shapes: `ownFields` (direct-only, like every
  // nested subsection's own `fields`) for the new recursive doc/form
  // renderers, and `fields` overwritten with the full flattened descendant
  // list for backward compatibility with every existing flat-shape consumer.
  const sections = root.subsections.map((top) => {
    const flatFields = [];
    collectFields(top, true, flatFields);
    const node = toSubsectionNode(top, 1);
    return { ...node, ownFields: node.fields, fields: flatFields };
  });

  if (sections.every((s) => s.fields.length === 0)) return null;
  return { sections, lessonBreakdownLabel, basicInfoBold, lessonSchema, themeOptions };
};

// filePath: local path to the uploaded .docx (multer disk storage already
// gives the controller one). Throws on an unreadable file or a parse that
// finds zero fields -- the only safety net in a review-less flow (see
// template.controller.js#upload).
const parseTemplateDocx = (filePath) => {
  const xml = readDocumentXml(filePath);
  const hasTable = /<w:tbl>/.test(xml);
  if (hasTable) {
    const labels = parseTableFields(xml);
    if (labels.length === 0) throw new Error(NO_FIELDS_ERROR);
    return asFlatSchema(labels);
  }

  const headingLevelMap = buildHeadingLevelMap(readStylesXml(filePath));
  if (headingLevelMap.size > 0 && documentUsesAnyHeadingStyle(xml, headingLevelMap)) {
    const schema = parseHeadingSections(xml, headingLevelMap);
    if (schema) return schema;
    // Fall through to the flat heuristic below if the heading-driven parse
    // came up empty (e.g. every heading got excluded/demoted) rather than
    // failing outright -- the flat heuristic still has a shot at the same
    // paragraphs with no heading awareness at all.
  }

  const labels = parseFlatFields(xml);
  if (labels.length === 0) throw new Error(NO_FIELDS_ERROR);
  return asFlatSchema(labels);
};

// Non-throwing: styling is a bonus on generated documents, never required.
// See dynamicDocGenerator.js#generateDoc's `stylesXml` option.
const extractStylesXml = (filePath) => readStylesXml(filePath);
const extractNumberingXml = (filePath) => readNumberingXml(filePath);
const extractThemeXml = (filePath) => readThemeXml(filePath);

// Resolves one template_versions row -> its own real word/{styles,numbering,
// theme1}.xml, each null when this version has no uploaded source file (a
// hand-authored seed version) or that file no longer exists on disk. Shared
// by plan.controller.js (a filled-in plan/execution doc's download) and
// template.controller.js#downloadBlank (the teacher-facing blank template)
// so every generateDoc call reproduces the real template's own fonts/
// numbering/theme the same way, rather than each resolving it by hand.
const resolveStylesXml = (version) =>
  version && version.sourceFilePath && fs.existsSync(version.sourceFilePath) ? extractStylesXml(version.sourceFilePath) : null;
const resolveNumberingXml = (version) =>
  version && version.sourceFilePath && fs.existsSync(version.sourceFilePath) ? extractNumberingXml(version.sourceFilePath) : null;
const resolveThemeXml = (version) =>
  version && version.sourceFilePath && fs.existsSync(version.sourceFilePath) ? extractThemeXml(version.sourceFilePath) : null;

// readDocumentXml/extractRuns are also exported for planDocExtract.js's
// own raw-XML table-row walker (see that file's tableRowTexts) -- both
// sides now live in the same backend package, so reusing the exact same
// "read word/document.xml via unzip" + "read a <w:p> chunk's runs" logic
// there is a plain require() away instead of a second copy.
module.exports = {
  parseTemplateDocx,
  extractStylesXml,
  extractNumberingXml,
  extractThemeXml,
  resolveStylesXml,
  resolveNumberingXml,
  resolveThemeXml,
  readDocumentXml,
  extractRuns,
  normalizeLabel,
};
