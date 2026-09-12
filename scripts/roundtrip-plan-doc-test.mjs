#!/usr/bin/env node
// Round-trip test for the plan-doc upload/extraction pipeline, run against a
// real running backend (dev by default -- see docker-compose.yml) via plain
// HTTP calls to the actual endpoints -- since backend/app/services/
// planDocExtract.js now does all extraction server-side (see
// plan.controller.js#uploadDesignDoc), this script never needs to import
// any application source, just fetch/FormData.
//
// The five steps under test:
//   1) template upload   -- POST /api/admin/templates/plan_design
//   2) plan creation      -- POST /api/plans, then PUT its planFormData
//   3) plan download      -- GET  /api/plans/:id/design-doc
//   4) downloaded file upload -- POST /api/plans/:id/design-doc (the
//                             bytes from step 3, unmodified)
//   5) verification: 2) == 4) -- re-fetch the plan after step 4 and assert
//      every field set in step 2 still holds the exact same value. Fields
//      whose template defines a hint (and which step 2 deliberately leaves
//      unset, to also exercise the hint-fallback-render-then-extract path
//      from PR #47) are excluded from this equality check and reported
//      separately -- step 3's download renders their hint text as normal
//      answer text, which step 4's re-upload then legitimately extracts as
//      if it were a real answer. That's a real, by-design difference
//      between "just created" (still unset) and "downloaded then
//      reuploaded" (now holds the hint text) for those specific fields, not
//      a bug -- asserting 2) == 4) there would be asserting the wrong thing.
//
// Steps 0.x (auth, template activation, cleanup) are plumbing around that
// core five-step flow, not part of what's under test.
//
// Usage: node scripts/roundtrip-plan-doc-test.mjs
// Env vars (all optional, defaults match this session's dev setup):
//   BACKEND_URL, ADMIN_EMAIL, ADMIN_TEST_PASSWORD, TEACHER_USERNAME,
//   TEACHER_PASSWORD, TEMPLATE_PATH
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8080";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin2@example.com";
const ADMIN_TEST_PASSWORD = process.env.ADMIN_TEST_PASSWORD || `RoundtripTest-${Date.now()}`;
const TEACHER_USERNAME = process.env.TEACHER_USERNAME || "teacher1";
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || "AutoTest123!";
const TEMPLATE_PATH =
  process.env.TEMPLATE_PATH || path.join(REPO_ROOT, "curriculum_template", "2026秋季学期乡土课程设计方案模板7.docx");

let pass = 0;
let fail = 0;
let skip = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
};
const skipField = (label, reason) => {
  skip++;
  console.log(`SKIP ${label} (${reason})`);
};

const api = async (method, urlPath, { token, body, isForm } = {}) => {
  const headers = {};
  if (token) headers["x-access-token"] = token;
  if (body && !isForm) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BACKEND_URL}/api${urlPath}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.arrayBuffer();
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${contentType.includes("application/json") ? JSON.stringify(data) : "(binary)"}`);
  }
  return data;
};

const fieldValue = (plan, multiSection, sectionKey, fieldKey) =>
  multiSection ? plan.planFormData[sectionKey] && plan.planFormData[sectionKey][fieldKey] : plan.planFormData[fieldKey];

let originalActiveVersionId = null;
let testVersionId = null;
let planId = null;

async function main() {
  console.log(`==> Backend: ${BACKEND_URL}`);
  console.log(`==> Template: ${TEMPLATE_PATH}`);

  console.log("\n==> Step 0.1: admin auth (resets a known test password on the admin account)");
  console.log(`    WARNING: resetting ${ADMIN_EMAIL}'s password via POST /api/auth/reset for this run.`);
  const adminToken = await signInAdminBootstrap();

  console.log("\n==> Step 0.2: teacher auth");
  const teacherLogin = await api("POST", "/auth/signin", { body: { username: TEACHER_USERNAME, password: TEACHER_PASSWORD } });
  const teacherToken = teacherLogin.accessToken;

  console.log("\n==> Step 0.3: snapshot currently-active plan_design template version (to restore in cleanup)");
  const versions = await api("GET", "/admin/templates/plan_design", { token: adminToken });
  const activeVersion = versions.find((v) => v.isActive);
  if (!activeVersion) throw new Error("No active plan_design template version found -- aborting, nothing to restore to.");
  originalActiveVersionId = activeVersion.id;
  console.log(`    original active version id=${originalActiveVersionId}`);

  console.log("\n==> Step 1: template upload");
  const templateBuf = fs.readFileSync(TEMPLATE_PATH);
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([templateBuf]), path.basename(TEMPLATE_PATH));
  const uploaded = await api("POST", "/admin/templates/plan_design", { token: adminToken, body: uploadForm, isForm: true });
  testVersionId = uploaded.id;
  console.log(`    uploaded as version id=${testVersionId} (inactive)`);
  console.log("    activating it so the new plan below pins to it");
  await api("PUT", `/admin/templates/plan_design/versions/${testVersionId}/activate`, { token: adminToken });

  console.log("\n==> Step 2: plan creation");
  const plan = await api("POST", "/plans", {
    token: teacherToken,
    body: { title: "ROUNDTRIP_TEST_乡土课程", year: 2026, season: "秋季", planMode: "online" },
  });
  planId = plan.id;
  console.log(`    plan id=${planId}`);

  const schema = plan.PlanTemplateVersion
    ? plan.PlanTemplateVersion.schemaJson
    : (await api("GET", `/plans/${planId}`, { token: teacherToken })).PlanTemplateVersion.schemaJson;
  const multiSection = schema.sections.length > 1;

  // Every real field gets a unique marker value, except fields whose
  // template defines a hint -- those are left unset on purpose (see the
  // header comment above).
  const hintFieldPaths = new Set();
  const planFormData = {};
  schema.sections.forEach((section) => {
    const bucket = multiSection ? (planFormData[section.key] = {}) : planFormData;
    (section.fields || []).forEach((field) => {
      const fieldPath = multiSection ? `${section.key}.${field.key}` : field.key;
      if (field.hint) {
        hintFieldPaths.add(fieldPath);
        return;
      }
      bucket[field.key] = `ANS_${field.key}_${Math.random().toString(36).slice(2, 8)}`;
    });
  });
  await api("PUT", `/plans/${planId}`, { token: teacherToken, body: { planFormData } });
  console.log(`    filled fields (${hintFieldPaths.size} hint-bearing fields deliberately left unset)`);

  // The authoritative "state after step 2" -- fetched fresh, not the
  // planFormData object we just built locally, so this reflects whatever
  // the backend actually persisted.
  const afterCreate = await api("GET", `/plans/${planId}`, { token: teacherToken });

  console.log("\n==> Step 3: plan download");
  const docxBuf = await api("GET", `/plans/${planId}/design-doc`, { token: teacherToken });
  console.log(`    downloaded ${docxBuf.byteLength} bytes`);

  console.log("\n==> Step 4: downloaded plan file upload");
  const reuploadForm = new FormData();
  reuploadForm.append("file", new Blob([docxBuf]), "roundtrip.docx");
  await api("POST", `/plans/${planId}/design-doc`, { token: teacherToken, body: reuploadForm, isForm: true });
  const afterReupload = await api("GET", `/plans/${planId}`, { token: teacherToken });

  console.log("\n==> Step 5: verification (2 == 4)");
  schema.sections.forEach((section) => {
    (section.fields || []).forEach((field) => {
      const fieldPath = multiSection ? `${section.key}.${field.key}` : field.key;
      if (hintFieldPaths.has(fieldPath)) {
        skipField(fieldPath, "hint-bearing field, deliberately left unset in step 2 -- expected to differ after step 4");
        return;
      }
      check(fieldPath, fieldValue(afterReupload, multiSection, section.key, field.key), fieldValue(afterCreate, multiSection, section.key, field.key));
    });
  });
}

async function signInAdminBootstrap() {
  await api("POST", "/auth/reset", { body: { email: ADMIN_EMAIL, password: ADMIN_TEST_PASSWORD } });
  const login = await api("POST", "/auth/signin", { body: { username: "admin2", password: ADMIN_TEST_PASSWORD } });
  return login.accessToken;
}

async function cleanup() {
  console.log("\n==> Cleanup");
  const adminToken = await (async () => {
    try {
      const login = await api("POST", "/auth/signin", { body: { username: "admin2", password: ADMIN_TEST_PASSWORD } });
      return login.accessToken;
    } catch (e) {
      console.log(`    could not re-auth as admin for cleanup: ${e.message}`);
      return null;
    }
  })();
  const teacherToken = await (async () => {
    try {
      const login = await api("POST", "/auth/signin", { body: { username: TEACHER_USERNAME, password: TEACHER_PASSWORD } });
      return login.accessToken;
    } catch (e) {
      return null;
    }
  })();

  if (planId && teacherToken) {
    try {
      await api("DELETE", `/plans/${planId}?confirmCascade=true`, { token: teacherToken });
      console.log(`    deleted plan id=${planId}`);
    } catch (e) {
      console.log(`    FAILED to delete plan id=${planId}: ${e.message}`);
    }
  }
  if (adminToken && originalActiveVersionId) {
    try {
      await api("PUT", `/admin/templates/plan_design/versions/${originalActiveVersionId}/activate`, { token: adminToken });
      console.log(`    restored active version id=${originalActiveVersionId}`);
    } catch (e) {
      console.log(`    FAILED to restore active version id=${originalActiveVersionId}: ${e.message}`);
    }
  }
  if (adminToken && testVersionId) {
    try {
      await api("DELETE", `/admin/templates/plan_design/versions/${testVersionId}?confirmDelete=true`, { token: adminToken });
      console.log(`    deleted test template version id=${testVersionId}`);
    } catch (e) {
      console.log(`    FAILED to delete test template version id=${testVersionId}: ${e.message}`);
    }
  }
}

main()
  .catch((e) => {
    fail++;
    console.error("\nERROR:", e.message);
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n==> ${pass} passed, ${fail} failed, ${skip} skipped`);
    process.exit(fail > 0 ? 1 : 0);
  });
