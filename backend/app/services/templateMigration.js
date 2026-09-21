// Matches fields between two plan_design template schema versions by label
// text (field.key is a per-parse positional counter -- see templateParser.js's
// assignKeys -- so it's meaningless across two different versions), and
// remaps one plan's planFormData from an old schema's shape onto a new one.
// Used by plan.controller.js#migrateMine, triggered per-version by
// template.controller.js#migrate.

const { normalizeLabel } = require("./templateParser");

// A handful of label spellings that different template revisions use
// interchangeably for the same anchor. Both sides normalize through this
// before comparison, so "其它目标" (old) and "其他目标" (new) -- or either
// spelling on either side -- match as the same field.
const SYNONYM_PAIRS = [[/其它/g, "其他"]];
const normalizeSynonyms = (text) => SYNONYM_PAIRS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);

// The key fields are matched on: colon-width-normalized (normalizeLabel,
// same rule templateParser.js uses when it renders/stores labels) and
// synonym-normalized (normalizeSynonyms).
const normalizeLabelForMatch = (label) => normalizeSynonyms(normalizeLabel(label));

// Minimum shared-prefix length (in normalized chars, colon excluded) for two
// labels to count as a prefix match -- guards against e.g. a lone "："
// matching everything. Real anchors are always longer than this.
const MIN_PREFIX_MATCH_LENGTH = 2;

const stripColon = (normalized) => normalized.replace(/[:：]\s*$/, "");

const commonPrefixLength = (a, b) => {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
};

// True if one normalized label is a prefix of the other (either direction --
// a template revision may add detail to an old anchor, e.g. old "公开展示方式"
// -> new "公开展示方式（真实受众）", or occasionally trim one down), long enough
// to not be a coincidence.
const isPrefixMatch = (normA, normB) => {
  const bareA = stripColon(normA);
  const bareB = stripColon(normB);
  if (bareA.length < MIN_PREFIX_MATCH_LENGTH || bareB.length < MIN_PREFIX_MATCH_LENGTH) return false;
  return commonPrefixLength(bareA, bareB) === Math.min(bareA.length, bareB.length);
};

// Every field in a schema, in document order. Deliberately just reads each
// top-level schema.sections[i].fields directly, WITHOUT also recursing into
// .subsections -- templateParser.js#parseHeadingSections already overwrites
// a top-level section's own `fields` with the fully-flattened descendant
// list (subsections' fields included, `group` set to each field's nearest
// ancestor heading -- see its own collectFields), precisely for "legacy
// flat-shape consumers" like this one. Recursing into `subsections` on top
// of that double-counts every nested field, since `subsections` entries
// carry that exact same content again under their own (direct-only)
// `fields` -- that double-counting bug is what caused every HOW field to
// also land in 手动迁移内容 (each field's second, "already consumed by a
// matched new field" copy fell through to onlyOld).
const flattenFields = (schema) => {
  const out = [];
  ((schema && schema.sections) || []).forEach((section) => {
    (section.fields || []).forEach((f) => out.push({ key: f.key, label: f.label, group: f.group || null, hint: f.hint || null }));
  });
  return out;
};

// Picks the best candidate for one old field out of several unused new-field
// candidates: prefer a same-`group` match (as before), else the one whose
// normalized label shares the longest prefix with the old field's (the most
// specific match), else the first.
const pickBestCandidate = (oldField, candidates) => {
  const sameGroup = candidates.find((f) => f.group === oldField.group);
  if (sameGroup) return sameGroup;
  const normOld = stripColon(normalizeLabelForMatch(oldField.label));
  let best = candidates[0];
  let bestOverlap = -1;
  candidates.forEach((f) => {
    const normNew = stripColon(normalizeLabelForMatch(f.label));
    const overlap = commonPrefixLength(normOld, normNew);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = f;
    }
  });
  return best;
};

// Fields present in both schemas, present only in the old one, or present
// only in the new one. Matching tries, in order: (1) exact normalized-label
// match (colon-width and 其它/其他-style synonyms folded together -- see
// normalizeLabelForMatch), (2) a prefix match in either direction (e.g. old
// "公开展示方式" -> new "公开展示方式（真实受众）", a revision that only added
// detail to an existing anchor). Both prefer a same-`group` candidate when a
// label is ambiguous within one schema.
const buildFieldMigrationPlan = (oldSchema, newSchema) => {
  const oldFields = flattenFields(oldSchema);
  const newFields = flattenFields(newSchema);

  const newByLabel = new Map();
  newFields.forEach((f) => {
    const key = normalizeLabelForMatch(f.label);
    if (!newByLabel.has(key)) newByLabel.set(key, []);
    newByLabel.get(key).push(f);
  });

  const matched = [];
  const onlyOld = [];
  const usedNewKeys = new Set();

  oldFields.forEach((oldField) => {
    const exactCandidates = (newByLabel.get(normalizeLabelForMatch(oldField.label)) || []).filter((f) => !usedNewKeys.has(f.key));

    let candidates = exactCandidates;
    if (candidates.length === 0) {
      const normOld = normalizeLabelForMatch(oldField.label);
      candidates = newFields.filter((f) => !usedNewKeys.has(f.key) && isPrefixMatch(normOld, normalizeLabelForMatch(f.label)));
    }

    if (candidates.length === 0) {
      onlyOld.push(oldField);
      return;
    }
    const newField = pickBestCandidate(oldField, candidates);
    usedNewKeys.add(newField.key);
    matched.push({ oldField, newField });
  });

  const matchedNewKeys = new Set(matched.map((m) => m.newField.key));
  const onlyNew = newFields.filter((f) => !matchedNewKeys.has(f.key));

  return { matched, onlyOld, onlyNew };
};

// A schema's planFormData storage shape: nested by section key when it has
// more than one top-level section, else every field key sits flat at the
// top level -- same rule dynamicDocGenerator.js#sectionAnswers and
// plan-detail.component.js#mergeFormData both already use.
const isMultiSection = (schema) => ((schema && schema.sections) || []).length > 1;

// Same "read the top-level section's own already-flattened `fields`, don't
// also recurse into `subsections`" rule as flattenFields above.
const sectionKeyForField = (schema, fieldKey) => {
  for (const section of (schema && schema.sections) || []) {
    if ((section.fields || []).some((f) => f.key === fieldKey)) return section.key;
  }
  return null;
};

const readFieldValue = (formData, schema, field) => {
  const data = formData || {};
  if (!isMultiSection(schema)) return data[field.key];
  const sectionKey = sectionKeyForField(schema, field.key);
  return sectionKey ? (data[sectionKey] || {})[field.key] : undefined;
};

const writeFieldValue = (target, schema, field, value) => {
  if (!isMultiSection(schema)) {
    target[field.key] = value;
    return;
  }
  const sectionKey = sectionKeyForField(schema, field.key);
  if (!sectionKey) return;
  target[sectionKey] = target[sectionKey] || {};
  target[sectionKey][field.key] = value;
};

// dynamicDocGenerator.js#p()'s own fallback when a field has no real value:
// the field's hint, or this generic placeholder when it has none. A plan
// that went out to docx and came back through upload extraction
// (planDocExtract.js) can end up with that exact placeholder text sitting in
// planFormData for a field the teacher never actually touched.
const GENERIC_BLANK_PLACEHOLDER = "（未填写）";

const normalizeForCompare = (text) => String(text).replace(/\s+/g, " ").trim();

// True for a value that's really "nothing" -- either genuinely empty, or
// containing no content beyond the field's own hint text (or the generic
// blank placeholder, for a field with no hint), i.e. a value that came back
// from doc round-tripping an untouched field rather than a real answer.
const isNullAnswer = (value, hint) => {
  if (value === undefined || value === null) return true;
  const normalized = normalizeForCompare(value);
  if (normalized === "") return true;
  const placeholder = normalizeForCompare(hint || GENERIC_BLANK_PLACEHOLDER);
  return normalized === placeholder;
};

// Remaps one plan's planFormData from oldSchema's shape onto newSchema's:
// matched fields carry their value over (null answers -- see isNullAnswer --
// are treated as unset and not migrated), new-only fields stay blank
// (nothing written), old-only fields with a real (non-null) value are
// collected into manualMigrationEntries instead of being dropped. `lessons`
// (分课时设计, a separate reusable per-lesson field template) is carried over
// unchanged -- diffing its own per-lesson schema is a distinct problem this
// doesn't cover.
const migratePlanFormData = (oldFormData, oldSchema, newSchema) => {
  const { matched, onlyOld } = buildFieldMigrationPlan(oldSchema, newSchema);
  const newFormData = {};

  matched.forEach(({ oldField, newField }) => {
    const value = readFieldValue(oldFormData, oldSchema, oldField);
    if (value !== undefined && !isNullAnswer(value, oldField.hint)) writeFieldValue(newFormData, newSchema, newField, value);
  });

  const manualMigrationEntries = onlyOld
    .map((field) => ({ label: field.label, group: field.group, value: readFieldValue(oldFormData, oldSchema, field), hint: field.hint }))
    .filter((entry) => !isNullAnswer(entry.value, entry.hint))
    .map(({ label, group, value }) => ({ label, group, value }));

  if (oldFormData && Array.isArray(oldFormData.lessons)) {
    newFormData.lessons = oldFormData.lessons;
  }

  if (manualMigrationEntries.length > 0) {
    newFormData._manualMigration = manualMigrationEntries;
  }

  return { newFormData, manualMigrationEntries };
};

module.exports = { flattenFields, buildFieldMigrationPlan, migratePlanFormData };
