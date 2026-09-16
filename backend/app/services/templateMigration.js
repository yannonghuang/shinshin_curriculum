// Matches fields between two plan_design template schema versions by label
// text (field.key is a per-parse positional counter -- see templateParser.js's
// assignKeys -- so it's meaningless across two different versions), and
// remaps one plan's planFormData from an old schema's shape onto a new one.
// Used by plan.controller.js#migrateMine, triggered per-version by
// template.controller.js#migrate.

const { normalizeLabel } = require("./templateParser");

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
    (section.fields || []).forEach((f) => out.push({ key: f.key, label: f.label, group: f.group || null }));
  });
  return out;
};

// Fields present in both schemas (matched by normalized label, preferring a
// same-`group` match when a label is ambiguous within one schema), present
// only in the old one, or present only in the new one.
const buildFieldMigrationPlan = (oldSchema, newSchema) => {
  const oldFields = flattenFields(oldSchema);
  const newFields = flattenFields(newSchema);

  const newByLabel = new Map();
  newFields.forEach((f) => {
    const key = normalizeLabel(f.label);
    if (!newByLabel.has(key)) newByLabel.set(key, []);
    newByLabel.get(key).push(f);
  });

  const matched = [];
  const onlyOld = [];
  const usedNewKeys = new Set();

  oldFields.forEach((oldField) => {
    const candidates = (newByLabel.get(normalizeLabel(oldField.label)) || []).filter((f) => !usedNewKeys.has(f.key));
    if (candidates.length === 0) {
      onlyOld.push(oldField);
      return;
    }
    const sameGroup = candidates.find((f) => f.group === oldField.group);
    const newField = sameGroup || candidates[0];
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

// Remaps one plan's planFormData from oldSchema's shape onto newSchema's:
// matched fields carry their value over, new-only fields stay blank
// (nothing written), old-only fields with a non-empty value are collected
// into manualMigrationEntries instead of being dropped. `lessons` (分课时设计,
// a separate reusable per-lesson field template) is carried over unchanged --
// diffing its own per-lesson schema is a distinct problem this doesn't cover.
const migratePlanFormData = (oldFormData, oldSchema, newSchema) => {
  const { matched, onlyOld } = buildFieldMigrationPlan(oldSchema, newSchema);
  const newFormData = {};

  matched.forEach(({ oldField, newField }) => {
    const value = readFieldValue(oldFormData, oldSchema, oldField);
    if (value !== undefined) writeFieldValue(newFormData, newSchema, newField, value);
  });

  const manualMigrationEntries = onlyOld
    .map((field) => ({ label: field.label, group: field.group, value: readFieldValue(oldFormData, oldSchema, field) }))
    .filter((entry) => entry.value !== undefined && entry.value !== null && entry.value !== "");

  if (oldFormData && Array.isArray(oldFormData.lessons)) {
    newFormData.lessons = oldFormData.lessons;
  }

  if (manualMigrationEntries.length > 0) {
    newFormData._manualMigration = manualMigrationEntries;
  }

  return { newFormData, manualMigrationEntries };
};

module.exports = { flattenFields, buildFieldMigrationPlan, migratePlanFormData };
