#!/usr/bin/env node
// End-to-end round-trip test for the "template upload -> plan download ->
// downloaded plan file re-upload -> verification" flow, run against a real
// running backend (dev by default -- see docker-compose.yml). Exercises the
// actual HTTP endpoints, not a hand-copied reimplementation of any
// extraction logic -- since backend/app/services/planDocExtract.js now does
// that extraction entirely server-side (see plan.controller.js#
// uploadDesignDoc), this script never needs to import any application
// source at all, just plain fetch/FormData.
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
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
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

let originalActiveVersionId = null;
let testVersionId = null;
let planId = null;

async function main() {
  console.log(`==> Backend: ${BACKEND_URL}`);
  console.log(`==> Template: ${TEMPLATE_PATH}`);

  console.log("\n==> Step 1: snapshot currently-active plan_design template version");
  const adminBootstrapToken = await signInAdminBootstrap();
  const versions = await api("GET", "/admin/templates/plan_design", { token: adminBootstrapToken });
  const activeVersion = versions.find((v) => v.isActive);
  if (!activeVersion) throw new Error("No active plan_design template version found -- aborting, nothing to restore to.");
  originalActiveVersionId = activeVersion.id;
  console.log(`    original active version id=${originalActiveVersionId}`);

  console.log("\n==> Step 2: admin auth (teacher auth already have a known test password)");
  console.log(`    WARNING: resetting ${ADMIN_EMAIL}'s password via POST /api/auth/reset for this run.`);
  const adminToken = adminBootstrapToken;

  console.log("\n==> Step 3: teacher auth");
  const teacherLogin = await api("POST", "/auth/signin", { body: { username: TEACHER_USERNAME, password: TEACHER_PASSWORD } });
  const teacherToken = teacherLogin.accessToken;

  console.log("\n==> Step 4: upload template");
  const templateBuf = fs.readFileSync(TEMPLATE_PATH);
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([templateBuf]), path.basename(TEMPLATE_PATH));
  const uploaded = await api("POST", "/admin/templates/plan_design", { token: adminToken, body: uploadForm, isForm: true });
  testVersionId = uploaded.id;
  console.log(`    uploaded as version id=${testVersionId} (inactive)`);

  console.log("\n==> Step 5: activate it");
  await api("PUT", `/admin/templates/plan_design/versions/${testVersionId}/activate`, { token: adminToken });

  console.log("\n==> Step 6: create + fill a plan");
  const plan = await api("POST", "/plans", {
    token: teacherToken,
    body: { title: "ROUNDTRIP_TEST_乡土课程", year: 2026, season: "秋季", planMode: "online" },
  });
  planId = plan.id;
  console.log(`    plan id=${planId}`);

  const planWithSchema = await api("GET", `/plans/${planId}`, { token: teacherToken });
  const schema = planWithSchema.PlanTemplateVersion.schemaJson;

  // Build markers for every real field, except a deliberately-chosen subset
  // of hint-bearing fields left unset (re-exercises the hint-fallback-
  // render-then-extract path from PR #47).
  const expected = {};
  const planFormData = {};
  const multiSection = schema.sections.length > 1;
  schema.sections.forEach((section) => {
    const bucket = multiSection ? (planFormData[section.key] = {}) : planFormData;
    (section.fields || []).forEach((field) => {
      if (field.hint) return; // left unset on purpose
      const marker = `ANS_${field.key}_${Math.random().toString(36).slice(2, 8)}`;
      bucket[field.key] = marker;
      expected[multiSection ? `${section.key}.${field.key}` : field.key] = marker;
    });
  });
  await api("PUT", `/plans/${planId}`, { token: teacherToken, body: { planFormData } });
  console.log(`    filled ${Object.keys(expected).length} fields with unique markers`);

  console.log("\n==> Step 7: download");
  const docxBuf = await api("GET", `/plans/${planId}/design-doc`, { token: teacherToken });
  console.log(`    downloaded ${docxBuf.byteLength} bytes`);

  console.log("\n==> Step 8: re-upload (the actual thing under test)");
  const reuploadForm = new FormData();
  reuploadForm.append("file", new Blob([docxBuf]), "roundtrip.docx");
  await api("POST", `/plans/${planId}/design-doc`, { token: teacherToken, body: reuploadForm, isForm: true });

  console.log("\n==> Step 9: verify");
  const finalPlan = await api("GET", `/plans/${planId}`, { token: teacherToken });
  Object.entries(expected).forEach(([path_, value]) => {
    const [sectionKey, fieldKey] = multiSection ? path_.split(".") : [null, path_];
    const actual = multiSection ? finalPlan.planFormData[sectionKey] && finalPlan.planFormData[sectionKey][fieldKey] : finalPlan.planFormData[fieldKey];
    check(path_, actual, value);
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
    console.log(`\n==> ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
