// Bridges a template_versions schema and the co-pilot's plan-writing tools
// (copilotActions.js): describes which fields a plan's 在线填写 form has, in
// a compact shape the model can fill, and maps the model's flat
// { fieldKey: value } answers back into the exact stored JSON shape the
// online form itself saves -- see dynamicDocGenerator.js's "Answers shape
// note" and plan-detail.component.js#mergeFormData:
//   - planFormData is nested by section key when the schema has more than
//     one top-level section, flat when it has exactly one;
//   - a section's values object holds every descendant field of that
//     section (subsection fields included -- renderSectionTree reads them
//     all from the same object);
//   - planFormData.lessons is a sparse [{ index, ...fieldKey: value }] array,
//     keyed by lessonSchema's own field keys, or { index, title, content }
//     when the template has no repeating 课时 schema (EMPTY_LESSON).
//
// Multi-section field keys are exposed to the model as "<sectionKey>.<fieldKey>"
// so they stay unambiguous regardless of how a given template's keys were
// assigned (a hand-authored seed's own names vs. a parsed template's f0/f1/...).

const MAX_HINT_LEN = 80;

const isMultiSection = (schema) => !!(schema && Array.isArray(schema.sections) && schema.sections.length > 1);

const trimHint = (hint) => {
  if (!hint) return undefined;
  const text = String(hint).trim();
  return text.length > MAX_HINT_LEN ? `${text.slice(0, MAX_HINT_LEN)}…` : text;
};

// Every fillable plan-level field, in document order, with the key the model
// must use when answering it.
const listPlanFields = (schema) => {
  const sections = (schema && schema.sections) || [];
  const multi = isMultiSection(schema);
  const out = [];
  for (const section of sections) {
    for (const f of section.fields || []) {
      out.push({
        key: multi ? `${section.key}.${f.key}` : f.key,
        section: section.label || section.key,
        group: f.group || undefined,
        label: f.label,
        hint: trimHint(f.hint),
      });
    }
  }
  return out;
};

// lessonSchema's own fields plus every nested subsection's, flattened -- a
// lesson's values object holds them all (see buildLessonDesignTrailingChildren).
const listLessonFields = (schema) => {
  const lessonSchema = schema && schema.lessonSchema;
  if (!lessonSchema) {
    return [
      { key: "title", label: "课时标题" },
      { key: "content", label: "课时内容" },
    ];
  }
  const out = [];
  const walk = (node, group) => {
    for (const f of node.fields || []) out.push({ key: f.key, group, label: f.label, hint: trimHint(f.hint) });
    for (const sub of node.subsections || []) walk(sub, sub.label);
  };
  walk(lessonSchema, undefined);
  return out;
};

// Applies { key: value } answers onto an existing answers object (planFormData
// or one 实施记录 entry), returning a new object -- untouched fields are kept,
// so "fill in 项目简介" doesn't wipe everything else. Unknown keys are
// reported rather than silently dropped, so the model can correct itself.
const applyFieldAnswers = (schema, existing, answers) => {
  const result = existing && typeof existing === "object" ? JSON.parse(JSON.stringify(existing)) : {};
  const unknownKeys = [];
  if (!answers || typeof answers !== "object") return { data: result, unknownKeys };

  const multi = isMultiSection(schema);
  const sections = (schema && schema.sections) || [];
  const validKeys = new Set(listPlanFields(schema).map((f) => f.key));

  for (const [key, rawValue] of Object.entries(answers)) {
    if (!validKeys.has(key)) {
      unknownKeys.push(key);
      continue;
    }
    const value = rawValue == null ? "" : String(rawValue);
    if (multi) {
      const dot = key.indexOf(".");
      const sectionKey = key.slice(0, dot);
      const fieldKey = key.slice(dot + 1);
      result[sectionKey] = { ...(result[sectionKey] || {}), [fieldKey]: value };
    } else {
      result[key] = value;
    }
  }
  // Multi-section schemas always carry every section object (even empty),
  // matching mergeFormData's own normalization on the frontend.
  if (multi) {
    for (const s of sections) if (!result[s.key]) result[s.key] = {};
  }
  return { data: result, unknownKeys };
};

// Merges [{ index, fields: { key: value } }] into a sparse lessons array.
const applyLessonAnswers = (schema, existingLessons, lessons) => {
  const result = Array.isArray(existingLessons) ? existingLessons.map((l) => ({ ...l })) : [];
  const unknownKeys = [];
  if (!Array.isArray(lessons)) return { lessons: result, unknownKeys };

  const validKeys = new Set(listLessonFields(schema).map((f) => f.key));
  for (const lesson of lessons) {
    const index = Number(lesson && lesson.index);
    if (!Number.isInteger(index) || index <= 0) {
      unknownKeys.push(`lessons[index=${lesson && lesson.index}]`);
      continue;
    }
    let entry = result.find((l) => Number(l.index) === index);
    if (!entry) {
      entry = { index };
      result.push(entry);
    }
    for (const [key, rawValue] of Object.entries((lesson && lesson.fields) || {})) {
      if (!validKeys.has(key)) {
        unknownKeys.push(`第${index}课时.${key}`);
        continue;
      }
      entry[key] = rawValue == null ? "" : String(rawValue);
    }
  }
  result.sort((a, b) => Number(a.index) - Number(b.index));
  return { lessons: result, unknownKeys };
};

// Same "any non-empty answer" test as plan-detail.component.js's
// hasAnySectionContent -- used by submit_plan's not-blank gate.
const hasAnyContent = (schema, answers) => {
  const hasValue = (obj) => Object.values(obj || {}).some((v) => v != null && typeof v !== "object" && String(v).trim() !== "");
  if (isMultiSection(schema)) return schema.sections.some((s) => hasValue(answers && answers[s.key]));
  return hasValue(answers);
};

module.exports = { listPlanFields, listLessonFields, applyFieldAnswers, applyLessonAnswers, hasAnyContent };
