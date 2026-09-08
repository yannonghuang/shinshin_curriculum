// Shared segment-key conventions for the per-segment revision tracking
// added alongside plans.contentVersionAt/reviews.planVersionAt -- see
// plan.model.js's segmentVersionAt comment. Used by plan.controller.js#update
// (to know which segment(s) actually changed on a given save) and
// review.controller.js#create (to snapshot the right entry onto a new
// review). Keeping both in one place keeps the two in sync: a key computed
// here for a plan edit must match the key a review of that same content
// resolves to, or the "edited since this review" comparison silently never
// fires.

// planFormData is nested by section key when the plan's template has more
// than one section (e.g. { WHY: {...}, WHAT: {...}, HOW: {...} }), plus a
// top-level "lessons" array (sparse, keyed by lesson index -- see
// plan-detail.component.js's onLessonFieldChange) for 分课时设计. Every
// other top-level key is treated as its own segment, keyed by its
// upper-cased name to match the sectionKey convention review-list.component.js
// already writes (section.key.toUpperCase()).
const diffPlanFormDataSegments = (oldFormData, newFormData) => {
  const before = oldFormData || {};
  const after = newFormData || {};
  const changed = [];

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("lessons");
  for (const key of keys) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      changed.push(key.toUpperCase());
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

  return changed;
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
// planVersionAt comparison only).
const segmentKeyForReview = (sectionKey, lessonIndex) => {
  if (!sectionKey) return null;
  if (sectionKey === "WHY" || sectionKey === "WHAT" || sectionKey === "HOW") return sectionKey;
  if ((sectionKey === "LESSON_DESIGN" || sectionKey === "EXECUTION_RECORD") && lessonIndex) {
    return `${sectionKey}:${lessonIndex}`;
  }
  return null;
};

module.exports = { diffPlanFormDataSegments, diffExecutionFormDataSegments, segmentKeyForReview };
