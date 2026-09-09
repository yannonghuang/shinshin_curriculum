// Shared segment-key conventions for the per-segment revision tracking
// added alongside plans.contentVersionAt/reviews.planVersionAt -- see
// plan.model.js's segmentVersionAt comment. Used by plan.controller.js#update
// (to know which segment(s) actually changed on a given save) and
// review.controller.js#create (to snapshot the right entry onto a new
// review). Keeping both in one place keeps the two in sync: a key computed
// here for a plan edit must match the key a review of that same content
// resolves to, or the "edited since this review" comparison silently never
// fires.

// Same "single lone wrapper" unwrap rule as plan-detail.component.js's
// anchorSections -- kept in sync deliberately (a review's sectionKey is
// stamped client-side from that same function's output, via
// section.key.toUpperCase()), since this needs the identical list of anchor
// sections to map a changed field back to the anchor a review might be
// scoped to.
const anchorSections = (schema) => {
  const sections = (schema && schema.sections) || [];
  if (sections.length === 1 && sections[0].subsections && sections[0].subsections.length > 0) {
    return sections[0].subsections;
  }
  return sections;
};

// Every field key anywhere under one anchor (its own direct fields plus
// every nested subsection's, recursively) -- an anchor like HOW can have all
// its real content several levels deep (see templateParser.js's heading-
// tree parsing), not just in its own `fields`.
const collectFieldKeys = (node, out) => {
  (node.fields || []).forEach((f) => out.push(f.key));
  (node.subsections || []).forEach((child) => collectFieldKeys(child, out));
};

// fieldKey -> owning anchor's own sectionKey (upper-cased, matching the
// convention review-list.component.js already writes), for a schema whose
// answers are stored flat (a heading-style-parsed template, or a table/flat-
// parsed one -- anything with exactly one top-level section, so
// onFormFieldChange stores every field directly on planFormData rather than
// nested under a section key). Null for a multi-section schema (the hand-
// authored WHY/WHAT/HOW seed), where planFormData's own top-level keys
// already *are* the section keys -- no field-level mapping needed there.
const buildFieldKeyToAnchorMap = (schema) => {
  if (!schema || !schema.sections || schema.sections.length > 1) return null;
  const map = {};
  anchorSections(schema).forEach((anchor) => {
    const keys = [];
    collectFieldKeys(anchor, keys);
    keys.forEach((key) => {
      map[key] = (anchor.key || "").toUpperCase();
    });
  });
  return map;
};

// planFormData is nested by section key when the plan's template has more
// than one section (e.g. { WHY: {...}, WHAT: {...}, HOW: {...} }), plus a
// top-level "lessons" array (sparse, keyed by lesson index -- see
// plan-detail.component.js's onLessonFieldChange) for 分课时设计. For a
// single-section (flat-stored) schema, every other top-level key is instead
// a *field* key, resolved back to its owning anchor via
// buildFieldKeyToAnchorMap -- e.g. editing one of WHY's fields on a heading-
// parsed template correctly bumps segment "S0" (WHY), not a meaningless
// per-field segment. Falls back to upper-casing the raw key directly
// (today's original behavior, exactly) whenever no schema is available or
// the changed key isn't one of the schema's own known fields (a multi-
// section schema's own "why"/"what"/"how" keys, or any other stray key).
const diffPlanFormDataSegments = (oldFormData, newFormData, schema) => {
  const before = oldFormData || {};
  const after = newFormData || {};
  const changed = [];
  const fieldKeyToAnchor = buildFieldKeyToAnchorMap(schema);

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("lessons");
  for (const key of keys) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      changed.push((fieldKeyToAnchor && fieldKeyToAnchor[key]) || key.toUpperCase());
    }
  }

  const beforeLessons = Array.isArray(before.lessons) ? before.lessons : [];
  const afterLessons = Array.isArray(after.lessons) ? after.lessons : [];
  const lessonIndices = new Set([...beforeLessons, ...afterLessons].map((l) => Number(l.index)));
  for (const index of lessonIndices) {
    const beforeLesson = beforeLessons.find((l) => Number(l.index) === index) || null;
    const afterLesson = afterLessons.find((l) => Number(l.index) === index) || null;
    if (JSON.stringify(beforeLesson) !== JSON.stringify(afterLesson)) {
      changed.push(`LESSON_DESIGN:${index}`);
    }
  }

  return [...new Set(changed)];
};

// executionFormData is a flat sparse array of 实施记录 entries keyed by
// lesson index (see plan-detail.component.js's onExecutionFieldChange), one
// segment per lesson.
const diffExecutionFormDataSegments = (oldExecutionFormData, newExecutionFormData) => {
  const before = Array.isArray(oldExecutionFormData) ? oldExecutionFormData : [];
  const after = Array.isArray(newExecutionFormData) ? newExecutionFormData : [];
  const changed = [];

  const indices = new Set([...before, ...after].map((r) => Number(r.index)));
  for (const index of indices) {
    const beforeRecord = before.find((r) => Number(r.index) === index) || null;
    const afterRecord = after.find((r) => Number(r.index) === index) || null;
    if (JSON.stringify(beforeRecord) !== JSON.stringify(afterRecord)) {
      changed.push(`EXECUTION_RECORD:${index}`);
    }
  }

  return changed;
};

// The segmentVersionAt key a review of a given sectionKey/lessonIndex maps
// to, or null when that combination isn't tracked at segment granularity
// (IMPLEMENTATION_OVERALL and plain 整体 comments have no single segment --
// they're reviews of the whole scope, and keep relying on the plan-wide
// planVersionAt comparison only). Any plain sectionKey -- "WHY"/"WHAT"/"HOW"
// for the hand-authored seed, or "S0"/"S1"/"S2"/... for a heading-style-
// parsed template's auto-keyed anchors (see anchorSections above) -- maps to
// itself; diffPlanFormDataSegments is what actually populates segmentVersionAt
// under that same key for either shape.
const segmentKeyForReview = (sectionKey, lessonIndex) => {
  if (!sectionKey) return null;
  if ((sectionKey === "LESSON_DESIGN" || sectionKey === "EXECUTION_RECORD") && lessonIndex) {
    return `${sectionKey}:${lessonIndex}`;
  }
  if (sectionKey === "IMPLEMENTATION_OVERALL") return null;
  return sectionKey;
};

module.exports = { diffPlanFormDataSegments, diffExecutionFormDataSegments, segmentKeyForReview };
