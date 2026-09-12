import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prompt } from "react-router-dom";
import mammoth from "mammoth/mammoth.browser";

import PlanDataService from "../services/plan.service";
import AuthService from "../services/auth.service";
import ReviewList from "./review-list.component";
import LessonFileManager from "./lesson-file-manager.component";
import { PLAN_THEMES, PLAN_GRADES, PLAN_SEASONS, PLAN_STATUSES, EMPTY_LESSON, currentSeason } from "../constants/plan-options";
import { consumeSkipUnsavedWarning } from "../utils/unsavedChangesGuard";
import "../curriculum.css";

// True if an answers object (shaped like planFormData/one executionFormData
// record) has at least one non-empty field, across however many sections the
// schema has -- used for the "提交待点评" not-empty gate below. Previously
// imported from utils/planDocExtract.js, which also used it (before that
// file's extraction moved server-side, see backend/app/services/
// planDocExtract.js) to decide whether an upload actually matched anything;
// kept here as a small local helper since this particular use has nothing to
// do with uploads.
const hasAnySectionContent = (schema, answers) => {
  const sections = (schema && schema.sections) || [];
  const hasValue = (obj) => Object.values(obj || {}).some((v) => v != null && String(v).trim() !== "");
  if (sections.length > 1) return sections.some((s) => hasValue(answers && answers[s.key]));
  return hasValue(answers);
};

// planFormData is nested by section key when its schema has more than one
// section (plan_design's seed: why/what/how), or flat when it has exactly
// one (any future re-uploaded template collapses to one section -- see the
// dynamic-templates plan) -- matches backend/app/services/planDocExtract.js#
// buildAnswersFromExtracted/dynamicDocGenerator.js's sectionAnswers exactly,
// so save/render/generate all agree on the same shape. `schema` is
// plan.PlanTemplateVersion.schemaJson.
const mergeFormData = (data, schema) => {
  const sections = (schema && schema.sections) || [];
  const lessons = Array.isArray(data && data.lessons) ? data.lessons : [];
  if (sections.length > 1) {
    const merged = { lessons };
    sections.forEach((s) => {
      merged[s.key] = { ...(data && data[s.key]) };
    });
    return merged;
  }
  return { ...(data || {}), lessons };
};

// "Anchoring level" -- the granularity at which the online form splits into
// separate sidebar pages and gets its own segment-level expert review block
// (see ReviewList's sectionKey prop below). For a heading-style-parsed
// template with a single top-level wrapper (see templateParser.js#
// parseHeadingSections) -- e.g. "WHY ·学习目标" nested one level under a lone
// top-level "课程设计框架" (confirmed on two real templates) -- that wrapper
// itself is never a real page (it has no content of its own, purely a
// grouping label), so this pulls its immediate subsections out as the real
// pages instead of lumping WHY/WHAT/HOW into one page under it.
//
// Unwrapping only fires when there's *exactly one* top-level section,
// though -- a third real template has no such wrapper at all (基本信息/WHY/
// WHAT/HOW/分课时设计 are all separate top-level Heading1s, with HOW's own
// 入项/探究/制作与迭代/出项 nested under it as Heading2). There, WHY/WHAT/HOW
// are already at the right granularity as top-level sections, exactly like
// the hand-authored seed and every table/flat-parsed schema -- and HOW must
// stay intact as one page (with its own subsections grouped inside it, per
// "same anchoring level -> same page"), not itself be unwrapped just because
// it happens to have subsections while its siblings don't. Deciding this per
// schema (sections.length) rather than per individual section is what makes
// that distinction correctly.
const anchorSections = (schema) => {
  const sections = (schema && schema.sections) || [];
  if (sections.length === 1 && sections[0].subsections && sections[0].subsections.length > 0) {
    return sections[0].subsections;
  }
  return sections;
};

// A node's own direct (non-descendant) fields: top-level schema.sections
// entries carry both `fields` (flattened, all descendants, kept for legacy
// flat-shape consumers -- see templateParser.js) and `ownFields` (direct-
// only); every other node (a nested subsection, or an anchor pulled from
// one) only ever has `fields`, which is already direct-only by construction.
const directFields = (section) => (section.ownFields !== undefined ? section.ownFields : section.fields || []);

// Renders one schema section's fields as labeled textareas, grouping
// consecutive same-`group` fields under one sub-heading and repeating
// "{group} · {label}" on each (same convention as HOW's own nested fields
// and 实施记录's 教学活动流程 -- see dynamicDocGenerator.js's identical
// grouping logic on the doc-generation side). Shared by every online-fill
// section (WHY/WHAT/HOW-equivalent and 实施记录-equivalent alike) instead of
// each hand-rolling its own field list.
//
// `subsections`, when present (a heading-style-parsed template -- see
// backend/app/services/templateParser.js#parseHeadingSections), recurses one
// level per nested heading, indented by `depth`, so a template's real multi-
// level outline (e.g. WHY/WHAT/HOW -> 最终成果 -> 个人成果/团队成果) renders as
// true nested groups rather than collapsing to a single `group` label.
// `values` stays the one flat per-top-level-section answers object at every
// depth -- field keys are globally unique across the whole schema (see
// onFormFieldChange/mergeFormData), so no per-depth answer namespacing is
// needed.
const DynamicSectionFields = ({ fields, subsections, values, canEdit, onFieldChange, depth = 0 }) => {
  let lastGroup;
  return (
    <>
      {(fields || []).map((field) => {
        const isNewGroup = field.group && field.group !== lastGroup;
        lastGroup = field.group;
        return (
          <React.Fragment key={field.key}>
            {isNewGroup && <h6 className="mt-3 mb-2">{field.group}</h6>}
            <div className="form-group">
              <label>{field.group ? `${field.group} · ${field.label}` : field.label}</label>
              <textarea
                className="form-control"
                rows="2"
                // field.hint only fills in while the field is genuinely
                // untouched (null/undefined) -- an explicit "" (the teacher
                // deliberately cleared it) stays blank rather than snapping
                // back. Rendered as real textarea content, not a `placeholder`
                // (which is native "vanishes on the first keystroke" browser
                // behavior) -- typing now edits within/around the hint text
                // instead of erasing it, and that first onChange carries it
                // forward into real saved state.
                value={values && values[field.key] != null ? values[field.key] : field.hint || ""}
                disabled={!canEdit}
                onChange={(e) => onFieldChange(field.key, e.target.value)}
              />
            </div>
          </React.Fragment>
        );
      })}
      {(subsections || []).map((sub) => (
        <div key={sub.key} style={{ marginLeft: depth * 16 }}>
          <h6 className="mt-3 mb-2">{sub.label}</h6>
          <DynamicSectionFields
            fields={sub.fields}
            subsections={sub.subsections}
            values={values}
            canEdit={canEdit}
            onFieldChange={onFieldChange}
            depth={depth + 1}
          />
        </div>
      ))}
    </>
  );
};

// Plan-level 课程设计文件 panel, reached from a single sidebar leaf (see
// PLAN_SECTIONS below). All three commands are shown at once:
// 下载/预览 act immediately on click; 上传 just toggles the drop-zone/browse
// UI open rather than acting itself, since it needs a file first. Nothing is
// materialized server-side for any of the three -- 下载/预览 both hit
// GET /plans/:id/design-doc (plan.controller.js#renderDoc), which renders the
// plan's *current* content into a .docx on the fly and streams it back, so
// there's no generated copy to go stale or to clean up; 上传 POSTs the
// dropped/picked .docx straight to that same path (plan.controller.js#
// uploadDesignDoc), which runs the best-effort extraction server-side (see
// backend/app/services/planDocExtract.js) and overwrites the plan's
// planFormData wholesale after an explicit confirm -- a destructive action,
// so it's gated behind a warning rather than a silent merge.
const DesignDocPanel = ({ planId, plan, canEdit, onUploadComplete }) => {
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(""); // "" | "download" | "preview"
  const [showUpload, setShowUpload] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const fileName = () => `${(plan && plan.title) || "乡土课程设计方案"}.docx`;

  const fetchDesignDocBuffer = async () => {
    const resp = await PlanDataService.downloadDesignDoc(planId);
    return resp.data;
  };

  const handleDownload = async () => {
    setMessage("");
    setWorking("download");
    try {
      const data = await fetchDesignDocBuffer();
      const url = window.URL.createObjectURL(
        new Blob([data], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", fileName());
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.log(e);
      setMessage("下载失败。");
    } finally {
      setWorking("");
    }
  };

  // Opens a blank window synchronously, before the first await, so the
  // browser attributes it to this click and doesn't treat it as a
  // popup-blocked async open -- then fills it in once the doc's rendered.
  // Same pattern as lesson-file-manager.component.js's openPreview.
  const handlePreview = async () => {
    setMessage("");
    setWorking("preview");
    const win = window.open("", "_blank");
    if (win) win.document.write(`<title>预览：${fileName()}</title><body>预览加载中...</body>`);
    try {
      const data = await fetchDesignDocBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: data });
      if (win) {
        win.document.open();
        win.document.write(
          `<!doctype html><html><head><meta charset="utf-8"><title>预览：${fileName()}</title>` +
            `<style>body{max-width:800px;margin:24px auto;padding:0 16px;font-family:sans-serif;line-height:1.6;}</style>` +
            `</head><body>${result.value || "<p>文档内容为空。</p>"}</body></html>`
        );
        win.document.close();
      }
    } catch (e) {
      console.log(e);
      setMessage("预览失败。");
      if (win) win.close();
    } finally {
      setWorking("");
    }
  };

  const handleUploadFile = async (file) => {
    if (!file) return;
    const ext = (file.name || "").toLowerCase().split(".").pop();
    if (ext !== "docx") {
      setMessage("仅支持上传 .docx 文件。");
      return;
    }
    if (
      !window.confirm(
        "上传新文件将覆盖当前课程设计方案的全部在线内容（WHY/WHAT/HOW 及分课时设计），且无法撤销，确定继续吗？"
      )
    ) {
      return;
    }
    setMessage("");
    setIsUploading(true);
    try {
      // Extraction (mammoth + label matching against this plan's own pinned
      // schema) now runs entirely server-side -- see backend/app/services/
      // planDocExtract.js and plan.controller.js#uploadDesignDoc -- so this
      // just ships the raw file and refreshes once the backend applies it.
      await PlanDataService.uploadDesignDoc(planId, file);
      await onUploadComplete("plan");
      setMessage("课程设计文件已上传，在线内容已更新。");
      setShowUpload(false);
    } catch (e) {
      console.log(e);
      setMessage((e && e.response && e.response.data && e.response.data.message) || "上传失败，请确认文件格式。");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div>
      {message && <div className="alert alert-info py-2">{message}</div>}

      <div className="mb-2">
        {canEdit && (
          <button
            className={`btn btn-sm mr-2 ${showUpload ? "btn-primary" : "btn-outline-primary"}`}
            type="button"
            onClick={() => setShowUpload((v) => !v)}
          >
            上传
          </button>
        )}
        <button className="btn btn-outline-primary btn-sm mr-2" type="button" onClick={handleDownload} disabled={working === "download"}>
          {working === "download" ? "下载中..." : "下载"}
        </button>
        <button className="btn btn-outline-primary btn-sm" type="button" onClick={handlePreview} disabled={working === "preview"}>
          {working === "preview" ? "生成中..." : "预览"}
        </button>
      </div>
      <div className="text-muted small mb-3">
        “下载”“预览”均根据课程设计方案的当前在线内容实时生成，不保存文件，每次都反映最新内容；预览将在新窗口中打开。
      </div>

      {showUpload && canEdit && (
        <div className="form-group">
          <label>上传课程设计文件（将覆盖当前在线内容）</label>
          <div
            className={`pl-file-drop-zone ${dragActive ? "is-dragover" : ""}`}
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              handleUploadFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
            }}
          >
            {isUploading ? "正在解析并上传..." : "拖拽 .docx 文件到这里，或点击选择文件以覆盖当前内容"}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            className="d-none"
            onChange={(e) => handleUploadFile(e.target.files[0])}
          />
          <small className="form-text text-muted">上传的文件将替换当前的 WHY/WHAT/HOW 及分课时设计内容，此操作无法撤销。</small>
        </div>
      )}
    </div>
  );
};

// Per-课时 课程实施文件 panel -- same 上传/下载/预览 pattern as DesignDocPanel
// above, scoped to one lesson's 实施记录 (plan.executionFormData) instead of
// the plan's own WHY/WHAT/HOW. 下载/预览 both hit
// GET /plans/:id/lessons/:lessonIndex/execution-doc
// (plan.controller.js#renderExecutionDoc), rendered on the fly from the
// lesson's current 实施记录 entry and never persisted. 上传 POSTs the
// dropped/picked .docx straight to that same path
// (plan.controller.js#uploadExecutionDoc), which extracts it server-side
// (driven by plan.ExecutionTemplateVersion's schema) and overwrites just
// this lesson's entry in plan.executionFormData, gated behind an explicit
// confirm, same as DesignDocPanel's 上传.
const LessonExecutionDocPanel = ({ planId, lessonIndex, plan, canEdit, onUploadComplete }) => {
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(""); // "" | "download" | "preview"
  const [showUpload, setShowUpload] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const fileName = () => `${(plan && plan.title) || "乡土课程设计方案"}-课时${lessonIndex}-实施记录.docx`;

  const fetchExecutionDocBuffer = async () => {
    const resp = await PlanDataService.downloadExecutionDoc(planId, lessonIndex);
    return resp.data;
  };

  const handleDownload = async () => {
    setMessage("");
    setWorking("download");
    try {
      const data = await fetchExecutionDocBuffer();
      const url = window.URL.createObjectURL(
        new Blob([data], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", fileName());
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.log(e);
      setMessage("下载失败。");
    } finally {
      setWorking("");
    }
  };

  const handlePreview = async () => {
    setMessage("");
    setWorking("preview");
    const win = window.open("", "_blank");
    if (win) win.document.write(`<title>预览：${fileName()}</title><body>预览加载中...</body>`);
    try {
      const data = await fetchExecutionDocBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer: data });
      if (win) {
        win.document.open();
        win.document.write(
          `<!doctype html><html><head><meta charset="utf-8"><title>预览：${fileName()}</title>` +
            `<style>body{max-width:800px;margin:24px auto;padding:0 16px;font-family:sans-serif;line-height:1.6;}</style>` +
            `</head><body>${result.value || "<p>文档内容为空。</p>"}</body></html>`
        );
        win.document.close();
      }
    } catch (e) {
      console.log(e);
      setMessage("预览失败。");
      if (win) win.close();
    } finally {
      setWorking("");
    }
  };

  const handleUploadFile = async (file) => {
    if (!file) return;
    const ext = (file.name || "").toLowerCase().split(".").pop();
    if (ext !== "docx") {
      setMessage("仅支持上传 .docx 文件。");
      return;
    }
    if (!window.confirm("上传新文件将覆盖本课时当前的实施记录内容，且无法撤销，确定继续吗？")) {
      return;
    }
    setMessage("");
    setIsUploading(true);
    try {
      // Extraction + merging into this lesson's slot of executionFormData
      // now happens entirely server-side (reading the plan's own current,
      // authoritative executionFormData column, not a client-supplied
      // in-memory array) -- see backend/app/services/planDocExtract.js and
      // plan.controller.js#uploadExecutionDoc.
      await PlanDataService.uploadExecutionDoc(planId, lessonIndex, file);
      await onUploadComplete("execution");
      setMessage("课程实施文件已上传，实施记录已更新。");
      setShowUpload(false);
    } catch (e) {
      console.log(e);
      setMessage((e && e.response && e.response.data && e.response.data.message) || "上传失败，请确认文件格式。");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div>
      {message && <div className="alert alert-info py-2">{message}</div>}

      <div className="mb-2">
        {canEdit && (
          <button
            className={`btn btn-sm mr-2 ${showUpload ? "btn-primary" : "btn-outline-primary"}`}
            type="button"
            onClick={() => setShowUpload((v) => !v)}
          >
            上传
          </button>
        )}
        <button className="btn btn-outline-primary btn-sm mr-2" type="button" onClick={handleDownload} disabled={working === "download"}>
          {working === "download" ? "下载中..." : "下载"}
        </button>
        <button className="btn btn-outline-primary btn-sm" type="button" onClick={handlePreview} disabled={working === "preview"}>
          {working === "preview" ? "生成中..." : "预览"}
        </button>
      </div>
      <div className="text-muted small mb-3">
        “下载”“预览”均根据本课时的当前实施记录实时生成，不保存文件，每次都反映最新内容；预览将在新窗口中打开。
      </div>

      {showUpload && canEdit && (
        <div className="form-group">
          <label>上传课程实施文件（将覆盖本课时当前的实施记录）</label>
          <div
            className={`pl-file-drop-zone ${dragActive ? "is-dragover" : ""}`}
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              handleUploadFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
            }}
          >
            {isUploading ? "正在解析并上传..." : "拖拽 .docx 文件到这里，或点击选择文件以覆盖当前内容"}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            className="d-none"
            onChange={(e) => handleUploadFile(e.target.files[0])}
          />
          <small className="form-text text-muted">上传的文件将替换本课时当前的实施记录内容，此操作无法撤销。</small>
        </div>
      )}
    </div>
  );
};

// Migrated from shinshin's case-detail.component.js, with the online-fill WHY/WHAT/HOW form
// (matching curriculum_template/乡土课程设计方案模版.docx's structure). Layout: a file-explorer
// style split -- a collapsible left nav tree (计划/its sections, 实施/its 课时 segments each
// admin-only 管理 leaf) drives a single-section content pane on the right, replacing the old
// waterfall of every card stacked vertically (and the react-tabs 课时 block) with one section
// visible at a time.
// WHY/WHAT/HOW-equivalent leaves aren't listed here -- they're driven
// entirely by plan.PlanTemplateVersion.schemaJson.sections at render time
// (see the "planSection" branch and the sidebar below), same as
// 分课时设计/实施记录 already were section content, not a fixed list. Both
// online and upload-mode plans get the same static leaves; only the
// schema-driven sections and 分课时设计 are gated to planMode === "online".
const PLAN_STATUS_LABELS = Object.fromEntries(PLAN_STATUSES.map((s) => [s.value, s.label]));

const PLAN_SECTIONS = [
  { key: "basic", label: "基本信息" },
  { key: "files", label: "课程设计文件" },
  { key: "reviews", label: "计划整体点评" },
];

const PlanDetail = (props) => {
  const planId = props.match.params.id;
  const [plan, setPlan] = useState(null);
  // sectionKey -> real anchor label (e.g. "S0" -> "WHY ·学习目标") -- a
  // heading-style-parsed template's anchors get auto-generated keys (see
  // anchorSections/section.key below), meaningless on their own in review-
  // list.component.js's "点评（...）" header, 模块 column, and aggregate-view
  // filtering. Memoized on the plan's pinned template id (stable for the
  // whole editing session) instead of recomputed fresh every render --
  // ReviewList depends on this object's identity in a fetch-triggering
  // useCallback, so a fresh object every render would refetch its review
  // list on every keystroke elsewhere on the page. Declared here, before any
  // of this component's early returns below, per the Rules of Hooks.
  const planSectionLabels = useMemo(() => {
    const schema = (plan && plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson) || { sections: [] };
    return Object.fromEntries(anchorSections(schema).map((s) => [s.key.toUpperCase(), s.label]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan && plan.PlanTemplateVersion && plan.PlanTemplateVersion.id]);
  // 乡土主题 dropdown options -- defaults to the static PLAN_THEMES list
  // (matches today's behavior, and covers a slow/failed fetch) then swapped
  // for the active plan_design template's own "附件"-derived list, if it has
  // one (see plan.controller.js#getOptions/templateParser.js#
  // extractThemeOptionsFromFields) -- a template can define its own theme
  // taxonomy without a code change.
  const [themeOptions, setThemeOptions] = useState(PLAN_THEMES);
  useEffect(() => {
    PlanDataService.getOptions()
      .then((resp) => {
        if (Array.isArray(resp.data && resp.data.themes) && resp.data.themes.length > 0) setThemeOptions(resp.data.themes);
      })
      .catch(() => {});
  }, []);
  const [isLoadingPlan, setIsLoadingPlan] = useState(true);
  const [message, setMessage] = useState("");
  const [metaForm, setMetaForm] = useState(null);
  // 基本信息 is always shown as a live editable form (no separate
  // view/edit toggle) -- seeded straight from the plan on every
  // retrievePlan() below.
  const [formData, setFormData] = useState({ lessons: [] });
  // Sparse array of 实施记录 entries, one per 课时, keyed by `index` -- same
  // shape as formData.lessons (see onLessonFieldChange), just plan-level
  // execution-record data instead of design content.
  const [executionFormData, setExecutionFormData] = useState([]);
  // Dirty tracking for the 保存草稿/提交待点评 button pairs -- planDirty
  // covers formData (WHY/WHAT/HOW + 分课时设计, both saved via
  // saveFormData), executionDirty covers executionFormData (every 课时's
  // 实施记录, saved together in one array via saveExecutionRecord). 提交待
  // 点评 needs no dirty tracking of its own: it's gated purely by
  // `plan.status === "draft"` (permanently disabled the moment a plan is
  // ever submitted -- status only ever moves away from "draft", never
  // back) and by planNotEmpty/executionNotEmpty (don't submit genuinely
  // blank content) -- both computed straight from the plan's actual
  // current data, so a plan born with content (e.g. created via 从文件导入)
  // is correctly submittable immediately, with no separate "a save
  // happened in this browsing session" flag required.
  const [planDirty, setPlanDirty] = useState(false);
  const [executionDirty, setExecutionDirty] = useState(false);
  // Same idea as planDirty/executionDirty above, scoped to metaForm (基本信息)
  // instead -- its own 保存草稿 button (saveMeta) needed the same
  // disabled-until-edited/re-disabled-after-save behavior as the other panes.
  const [metaDirty, setMetaDirty] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  // planLessons (分课时设计, nested under 计划) starts collapsed, unlike plan/
  // execution -- it can hold as many leaves as 实施's own 课时 list, and it's
  // one level deeper, so expanding it by default would make the plan section
  // of the sidebar as tall as the whole 实施 tree before a teacher's even
  // looked at it.
  const [expandedGroups, setExpandedGroups] = useState({ plan: true, execution: true, planLessons: false });
  const [selected, setSelected] = useState({ type: "plan", key: "basic" });
  // Lifted up from the two 整体点评 ReviewList widgets (design/implementation)
  // rather than left as their own local state -- switching sidebar tabs
  // unmounts/remounts those widgets, and an AI review request is a single
  // synchronous call that can keep running well after that; keeping the
  // "still generating" flag here, on a component that stays mounted for the
  // whole page, means "AI点评生成中..." survives clicking away and back
  // (see review-list.component.js's aiPending/setAiPending props).
  const [aiReviewPending, setAiReviewPending] = useState({ design: false, implementation: false });

  const toggleGroup = (name) => setExpandedGroups((prev) => ({ ...prev, [name]: !prev[name] }));
  const select = (type, key) => setSelected({ type, key });

  const retrievePlan = useCallback(async () => {
    setIsLoadingPlan(true);
    try {
      const resp = await PlanDataService.get(planId);
      setPlan(resp.data);
      setMetaForm({
        title: resp.data.title || "",
        theme: resp.data.theme || "",
        grade: resp.data.grade || "",
        studentCount: resp.data.studentCount ? String(resp.data.studentCount) : "",
        instructorName: resp.data.instructorName || "",
        year: resp.data.year ? String(resp.data.year) : "",
        // Falls back to the current 学期 rather than "" -- covers both a
        // freshly-created plan and an older one from before this field
        // existed, so the select always shows a sensible value instead of
        // a blank "不限".
        season: resp.data.season || currentSeason(),
        plannedLessonCount: resp.data.plannedLessonCount ? String(resp.data.plannedLessonCount) : "",
      });
      setMetaDirty(false);
      setFormData(mergeFormData(resp.data.planFormData, resp.data.PlanTemplateVersion && resp.data.PlanTemplateVersion.schemaJson));
      setExecutionFormData(Array.isArray(resp.data.executionFormData) ? resp.data.executionFormData : []);
    } catch (e) {
      console.log(e);
      setPlan(null);
      setMessage(e?.response?.data?.message || "加载课程设计详情失败。");
    } finally {
      setIsLoadingPlan(false);
    }
  }, [planId]);

  useEffect(() => {
    retrievePlan();
  }, [retrievePlan]);

  // Covers actual tab close/refresh/typed-URL navigation -- the in-app
  // <Prompt> below (same planDirty/executionDirty/metaDirty condition) covers
  // react-router navigation (返回, browser back/forward) instead, since
  // beforeunload doesn't fire for client-side route changes.
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (!planDirty && !executionDirty && !metaDirty) return;
      // Set by e.g. App.js's logOut right before a reload it already got
      // explicit confirmation for via its own push-triggered <Prompt> --
      // this component isn't guaranteed to have unmounted (and torn down
      // this very listener) synchronously by that point, so without this
      // check the same question would get asked a second, redundant time.
      if (consumeSkipUnsavedWarning()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [planDirty, executionDirty, metaDirty]);

  const currentUser = AuthService.getCurrentUser();
  const isOwner = !!(plan && currentUser && String(plan.teacherId) === String(currentUser.id));
  const isAdmin = AuthService.isAdmin();
  // Always editable for the owner/admin, regardless of status (submitting for
  // review no longer locks the plan) -- previously gated on plan.status ===
  // "draft", which made it read-only the moment a teacher clicked 提交待点评.
  // Editing a plan's content is owner-only, no admin bypass -- managers can
  // suspend/promote/leave notes (see the 管理员操作 card below) but not edit
  // case content, even one they don't own (matches plan.controller.js#update,
  // which enforces the same rule server-side). A suspended plan is
  // additionally locked against edits even for its owner, until an admin
  // unsuspends it.
  const canEditPlan = isOwner && !(plan && plan.suspended);
  // 支撑材料 download is opened up to admins ("manager", the seeded admin
  // account's persona -- see role.model.js) reviewing a plan they don't own,
  // unlike upload/move/delete which stay owner-only via canEditPlan above.
  const canDownloadPlan = canEditPlan || isAdmin;

  const goBack = () => props.history.push("/plans");

  const updateMetaForm = (patch) => {
    setMetaForm((prev) => ({ ...prev, ...patch }));
    setMetaDirty(true);
  };

  const saveMeta = async (e) => {
    e.preventDefault();
    try {
      await PlanDataService.update(planId, {
        title: metaForm.title,
        theme: metaForm.theme || null,
        grade: metaForm.grade || null,
        studentCount: metaForm.studentCount ? Number(metaForm.studentCount) : null,
        instructorName: metaForm.instructorName || null,
        year: Number(metaForm.year),
        season: metaForm.season || null,
        plannedLessonCount: metaForm.plannedLessonCount ? Number(metaForm.plannedLessonCount) : null,
      });
      setMetaDirty(false);
      setMessage("课程设计信息已更新。");
      retrievePlan();
    } catch (err) {
      setMessage(err?.response?.data?.message || "更新失败。");
    }
  };

  // Mirrors mergeFormData's multi-vs-single-section branching: nested-by-
  // section-key when the plan's schema has more than one section (the seed
  // WHY/WHAT/HOW), flat when it has exactly one (any future re-uploaded
  // template collapses to one -- see the dynamic-templates plan).
  const onFormFieldChange = (sectionKey, field, value) => {
    const sections = (plan && plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson && plan.PlanTemplateVersion.schemaJson.sections) || [];
    setFormData((prev) =>
      sections.length > 1 ? { ...prev, [sectionKey]: { ...prev[sectionKey], [field]: value } } : { ...prev, [field]: value }
    );
    setPlanDirty(true);
  };

  // formData.lessons is a sparse array of { index, title, content } (see
  // EMPTY_LESSON) -- index n may have no entry yet (a plan with no lesson
  // content filled in, or a lesson beyond what's been written so far), so this
  // creates one on first edit rather than requiring every lessonCount slot to
  // be pre-populated up front.
  const onLessonFieldChange = (lessonIndex, field, value) => {
    setFormData((prev) => {
      const lessons = prev.lessons.some((l) => Number(l.index) === lessonIndex)
        ? prev.lessons.map((l) => (Number(l.index) === lessonIndex ? { ...l, [field]: value } : l))
        : [...prev.lessons, { ...EMPTY_LESSON, index: lessonIndex, [field]: value }];
      return { ...prev, lessons };
    });
    setPlanDirty(true);
  };

  // executionFormData is a sparse array of 实施记录 entries, same shape as
  // formData.lessons (see onLessonFieldChange above) -- creates an entry on
  // first edit rather than requiring every lesson slot pre-populated. No
  // base "empty record" to spread in (unlike before this became
  // schema-driven) -- a field missing from a fresh entry just isn't in the
  // object yet, which DynamicSectionFields already renders as "" (see its
  // `values && values[field.key]) || ""`).
  const onExecutionFieldChange = (lessonIndex, field, value) => {
    setExecutionFormData((prev) =>
      prev.some((r) => Number(r.index) === lessonIndex)
        ? prev.map((r) => (Number(r.index) === lessonIndex ? { ...r, [field]: value } : r))
        : [...prev, { index: lessonIndex, [field]: value }]
    );
    setExecutionDirty(true);
  };

  // Same 保存草稿/提交待点评 split as saveFormData above -- 提交待点评 bumps
  // the plan's own `status` (there's no separate per-课时 status field; a
  // 课时's 实施记录 form just gets the same submit action every other
  // section already has, reusing the same plan-level 待点评 queue).
  const saveExecutionRecord = async (submitStatus) => {
    try {
      await PlanDataService.update(planId, {
        executionFormData,
        status: submitStatus || undefined,
      });
      setExecutionDirty(false);
      setMessage(submitStatus === "submitted" ? "实施记录已提交。" : "实施记录已保存。");
      retrievePlan();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存失败。");
    }
  };

  const saveFormData = async (submitStatus) => {
    try {
      await PlanDataService.update(planId, {
        planFormData: formData,
        status: submitStatus || undefined,
      });
      setPlanDirty(false);
      setMessage(submitStatus === "submitted" ? "课程设计方案已提交。" : "课程设计方案已保存。");
      retrievePlan();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存失败。");
    }
  };

  // Shared by both doc-upload panels below (DesignDocPanel/
  // LessonExecutionDocPanel), called once their own upload request (which
  // now goes straight to plan.controller.js#uploadDesignDoc/
  // uploadExecutionDoc -- see PlanDataService.uploadDesignDoc/
  // uploadExecutionDoc -- and already persisted its own domain server-side)
  // has succeeded. `justUploadedDomain` is "plan" or "execution" -- per the
  // user's requirement, this still also flushes whatever *other* domain is
  // currently dirty in memory, so an upload never silently strands unsaved
  // edits sitting elsewhere on the page; unlike the old onUploadReplace this
  // is necessarily a second request now (the new upload endpoints only
  // accept the file itself), not the same one, but the net effect -- both
  // domains end up saved -- is unchanged.
  const onUploadComplete = async (justUploadedDomain) => {
    const otherPayload = {};
    if (justUploadedDomain !== "plan" && planDirty) otherPayload.planFormData = formData;
    if (justUploadedDomain !== "execution" && executionDirty) otherPayload.executionFormData = executionFormData;
    if (Object.keys(otherPayload).length > 0) {
      await PlanDataService.update(planId, otherPayload);
    }
    setPlanDirty(false);
    setExecutionDirty(false);
    retrievePlan();
  };

  const toggleExcellent = async () => {
    try {
      await PlanDataService.update(planId, { isExcellentCase: !plan.isExcellentCase });
      retrievePlan();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };

  const toggleSuspend = async () => {
    if (!plan.suspended) {
      const ok = window.confirm(`确定停用「${plan.title}」吗？停用后该课程设计将从公开列表中隐藏，仅本人与管理员可见。`);
      if (!ok) return;
    }
    try {
      if (plan.suspended) {
        await PlanDataService.unsuspend(planId);
      } else {
        await PlanDataService.suspend(planId);
      }
      retrievePlan();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };

  if (isLoadingPlan) {
    return (
      <div className="container pl-page">
        <div className="pl-empty">加载中...</div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="container pl-page">
        <div className="alert alert-danger py-2 mb-0">{message || "加载课程设计详情失败。"}</div>
      </div>
    );
  }

  const lessonCount = plan.plannedLessonCount || 0;
  const lessons = Array.from({ length: lessonCount }, (_, i) => i + 1);
  const planTemplateSchema = (plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson) || { sections: [] };
  const planSchemaMultiSection = planTemplateSchema.sections.length > 1;
  // The sidebar's WHY/WHAT/HOW-equivalent pages and their review blocks are
  // built from these, not planTemplateSchema.sections directly -- see
  // anchorSections' comment.
  const planAnchorSections = anchorSections(planTemplateSchema);
  // Hoisted here (rather than locally inside the executionRecord branch
  // below) so it's available for executionNotEmpty too.
  const executionTemplateSchema = (plan.ExecutionTemplateVersion && plan.ExecutionTemplateVersion.schemaJson) || { sections: [] };
  // "Not empty" gate for 提交待点评 -- reuses hasAnySectionContent, the same
  // "did the user actually write anything" check already used for
  // upload-extraction (see DesignDocPanel/LessonExecutionDocPanel below).
  const planNotEmpty =
    hasAnySectionContent(planTemplateSchema, formData) ||
    (formData.lessons || []).some((l) =>
      planTemplateSchema.lessonSchema
        ? Object.keys(l).some((k) => k !== "index" && l[k] != null && String(l[k]).trim() !== "")
        : (l.title || "").trim() || (l.content || "").trim()
    );
  const executionNotEmpty = executionFormData.some((r) => hasAnySectionContent(executionTemplateSchema, r));

  // AI已点评/专家已点评 are derived from plan.Reviews (already fetched with this
  // plan, see plan.controller.js#findOne), not separate stored flags -- "has
  // this plan received at least one review of that reviewerType". "专家"
  // means reviewerType==='expert' specifically, not 'admin' (see
  // review.model.js's own comment on why those stay distinct).
  const planReviews = plan.Reviews || [];
  const expertReviews = planReviews.filter((r) => r.reviewerType === "expert");
  const reviewFlags = {
    aiReviewed: planReviews.some((r) => r.reviewerType === "ai"),
    expertReviewed: expertReviews.length > 0,
    expertReviewerNames: [...new Set(expertReviews.map((r) => (r.Reviewer ? r.Reviewer.chineseName || r.Reviewer.username : "专家")))],
  };

  const renderContent = () => {
    if (selected.type === "plan" && selected.key === "basic") {
      return (
        <div className="pl-card">
          <h6>基本信息</h6>
          <div className="mb-3">
            <span className={`pl-plan-card-status status-${plan.status || "draft"}`}>
              {(PLAN_STATUSES.find((s) => s.value === plan.status) || PLAN_STATUSES[0]).label}
            </span>
            {reviewFlags.aiReviewed && <span className="pl-tag-ai ml-2">AI已点评</span>}
            {reviewFlags.expertReviewed && <span className="pl-tag-expert ml-2">专家已点评</span>}
            {reviewFlags.expertReviewed && (
              <span className="text-muted ml-2" style={{ fontSize: "12px" }}>
                （{reviewFlags.expertReviewerNames.join("、")}）
              </span>
            )}
          </div>
          <form onSubmit={saveMeta}>
            <div className="form-group">
              <label>标题</label>
              {/* textarea (not a single-line input) so a long 标题 (project
                  titles here routinely run past what a single-line input can
                  show, e.g. "伞韵米香·寻味五溪——...") wraps and stays fully
                  visible instead of scrolling off sideways; overflowY: auto
                  caps its growth and scrolls internally past maxHeight rather
                  than pushing the rest of the form down indefinitely. */}
              <textarea
                className="form-control"
                rows={2}
                style={{ resize: "vertical", overflowY: "auto", maxHeight: "150px" }}
                value={metaForm.title}
                onChange={(e) => updateMetaForm({ title: e.target.value })}
                disabled={!canEditPlan}
                required
              />
            </div>
            <div className="form-row">
              <div className="form-group col-md-3">
                <label>年份</label>
                <input
                  className="form-control"
                  type="number"
                  value={metaForm.year}
                  onChange={(e) => updateMetaForm({ year: e.target.value })}
                  disabled={!canEditPlan}
                  required
                />
              </div>
              <div className="form-group col-md-3">
                <label>学季</label>
                <select className="form-control" value={metaForm.season} onChange={(e) => updateMetaForm({ season: e.target.value })} disabled={!canEditPlan}>
                  {PLAN_SEASONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group col-md-3">
                <label>乡土主题</label>
                <select className="form-control" value={metaForm.theme} onChange={(e) => updateMetaForm({ theme: e.target.value })} disabled={!canEditPlan}>
                  <option value="">不限</option>
                  {themeOptions.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group col-md-3">
                <label>年级</label>
                <select className="form-control" value={metaForm.grade} onChange={(e) => updateMetaForm({ grade: e.target.value })} disabled={!canEditPlan}>
                  <option value="">不限</option>
                  {PLAN_GRADES.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group col-md-4">
                <label>学生人数</label>
                <input
                  className="form-control"
                  type="number"
                  min="0"
                  value={metaForm.studentCount}
                  onChange={(e) => updateMetaForm({ studentCount: e.target.value })}
                  disabled={!canEditPlan}
                />
              </div>
              <div className="form-group col-md-4">
                <label>执教人</label>
                <input
                  className="form-control"
                  type="text"
                  value={metaForm.instructorName}
                  onChange={(e) => updateMetaForm({ instructorName: e.target.value })}
                  disabled={!canEditPlan}
                />
              </div>
              <div className="form-group col-md-4">
                <label>预计课时</label>
                <input
                  className="form-control"
                  type="number"
                  min="1"
                  max="60"
                  value={metaForm.plannedLessonCount}
                  onChange={(e) => updateMetaForm({ plannedLessonCount: e.target.value })}
                  disabled={!canEditPlan}
                />
              </div>
            </div>
            {canEditPlan && (
              <button className="btn btn-primary" type="submit" disabled={!metaDirty}>
                保存草稿
              </button>
            )}
          </form>
        </div>
      );
    }

    // WHY/WHAT/HOW-equivalent -- one generic branch driven by whichever
    // sections plan.PlanTemplateVersion.schemaJson has (at the anchoring
    // level -- see anchorSections), replacing what used to be three separate
    // hand-written branches each hardcoding their own field list.
    // selected.key is an anchor section's key (e.g. "why"/"what"/"how" for
    // the seed template, the heading-parsed WHY/WHAT/HOW's own auto-assigned
    // keys for a re-uploaded one, or "main" for a table/flat-parsed one).
    if (selected.type === "planSection") {
      const section = planAnchorSections.find((s) => s.key === selected.key);
      if (!section) return null;
      const values = planSchemaMultiSection ? formData[section.key] || {} : formData;
      return (
        <div className="pl-card pl-why-what-how">
          <h6>{section.label}</h6>
          <DynamicSectionFields
            fields={directFields(section)}
            subsections={section.subsections}
            values={values}
            canEdit={canEditPlan}
            onFieldChange={(field, value) => onFormFieldChange(section.key, field, value)}
          />
          {canEditPlan && (
            <div className="d-flex mt-2">
              <button className="btn btn-primary mr-2" type="button" onClick={() => saveFormData()} disabled={!planDirty}>
                保存草稿
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => saveFormData("submitted")}
                disabled={plan.status !== "draft" || !planNotEmpty}
              >
                提交待点评
              </button>
            </div>
          )}
          <hr />
          <ReviewList
            planId={planId}
            lessonIndex={null}
            sectionKey={section.key.toUpperCase()}
            sectionLabels={planSectionLabels}
            embedded
            planContentVersionAt={plan.contentVersionAt}
            segmentVersionAt={plan.segmentVersionAt}
          />
        </div>
      );
    }

    if (selected.type === "plan" && selected.key === "files") {
      return (
        <div className="pl-card">
          <div className="mb-2">
            <h6 className="mb-0">课程设计文件</h6>
          </div>
          <DesignDocPanel planId={planId} plan={plan} canEdit={canEditPlan} onUploadComplete={onUploadComplete} />
        </div>
      );
    }

    if (selected.type === "plan" && selected.key === "reviews") {
      return (
        <div className="pl-card">
          <h6>计划整体点评</h6>
          <ReviewList
            planId={planId}
            lessonIndex={null}
            sectionLabels={planSectionLabels}
            embedded
            planContentVersionAt={plan.contentVersionAt}
            segmentVersionAt={plan.segmentVersionAt}
            canTriggerAi={canEditPlan}
            aiPending={aiReviewPending.design}
            setAiPending={(v) => setAiReviewPending((prev) => ({ ...prev, design: v }))}
            // Lets the aggregate view's 模块 column jump straight to that
            // section's own tab. "LESSON_DESIGN" rows carry their lessonIndex
            // and route to that lesson's own tab; everything else is a
            // schema section key stored upper-cased (see the "planSection"
            // branch's own ReviewList, which passes section.key.toUpperCase()),
            // so this reverses that to match the schema's actual key.
            onSelectSection={(key, lessonIdx) =>
              key === "LESSON_DESIGN" ? select("planLesson", lessonIdx) : select("planSection", key.toLowerCase())
            }
          />
        </div>
      );
    }

    // "第二部分：分课时设计" in the template is part of the *design* document (课程设计
    // 方案) -- the teacher's planned title/content for each 课时 -- not a record of
    // what actually happened in class. That's why it lives under 计划's own
    // "分课时设计" sub-tree (see the sidebar below) rather than inside 实施's 课时 N
    // panes, which are for actual delivery evidence (uploaded artifacts, reviews).
    if (selected.type === "planLesson") {
      const n = selected.key;
      // lessons is a sparse array (see onLessonFieldChange), so a lesson with
      // nothing written yet falls back to EMPTY_LESSON (harmless even when
      // lessonSchema is present -- its unused title/content keys are just
      // ignored by DynamicSectionFields, which only reads its own field keys).
      const lesson = formData.lessons.find((l) => Number(l.index) === n) || EMPTY_LESSON;
      const lessonSchema = planTemplateSchema.lessonSchema;
      return (
        <div className="pl-card pl-why-what-how">
          <h6>分课时设计 · 课时 {n}</h6>
          {lessonSchema ? (
            // Schema-driven: a reusable per-课时 field template extracted
            // from the source template itself (see templateParser.js#
            // extractLessonSchema) -- applied once per lesson index, same
            // convention as the executionRecord branch below.
            <DynamicSectionFields
              fields={lessonSchema.fields}
              subsections={lessonSchema.subsections}
              values={lesson}
              canEdit={canEditPlan}
              onFieldChange={(field, value) => onLessonFieldChange(n, field, value)}
            />
          ) : (
            // Freeform fallback -- every template with no detectable
            // repeating 课时-marker pattern (or parsed before this existed).
            <>
              <div className="form-group">
                <label>课时标题</label>
                <input
                  className="form-control"
                  value={lesson.title}
                  disabled={!canEditPlan}
                  onChange={(e) => onLessonFieldChange(n, "title", e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>课时设计内容</label>
                <textarea
                  className="form-control"
                  rows="10"
                  value={lesson.content}
                  disabled={!canEditPlan}
                  onChange={(e) => onLessonFieldChange(n, "content", e.target.value)}
                />
              </div>
            </>
          )}
          {canEditPlan && (
            <div className="d-flex mt-2">
              <button className="btn btn-primary mr-2" type="button" onClick={() => saveFormData()} disabled={!planDirty}>
                保存草稿
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => saveFormData("submitted")}
                disabled={plan.status !== "draft" || !planNotEmpty}
              >
                提交待点评
              </button>
            </div>
          )}
          <hr />
          <ReviewList
            planId={planId}
            lessonIndex={n}
            sectionKey="LESSON_DESIGN"
            embedded
            planContentVersionAt={plan.contentVersionAt}
            segmentVersionAt={plan.segmentVersionAt}
          />
        </div>
      );
    }

    // 课时N under 实施 splits into four leaves (see the sidebar below),
    // following the same "online form + on-the-fly 上传/下载/预览 doc panel"
    // pattern 计划's own 课程设计文件 uses -- executionRecord is the form,
    // executionDoc is the doc panel, and the other two are today's
    // LessonFileManager/ReviewList, just no longer combined into one pane.
    if (selected.type === "executionRecord") {
      const n = selected.key;
      const record = executionFormData.find((r) => Number(r.index) === n) || {};
      const section = executionTemplateSchema.sections[0] || { fields: [] };
      return (
        <div className="pl-card pl-why-what-how">
          <h6>实施记录 · 课时 {n}</h6>
          <DynamicSectionFields
            fields={directFields(section)}
            subsections={section.subsections}
            values={record}
            canEdit={canEditPlan}
            onFieldChange={(field, value) => onExecutionFieldChange(n, field, value)}
          />
          {canEditPlan && (
            <div className="d-flex mt-2">
              <button className="btn btn-primary mr-2" type="button" onClick={() => saveExecutionRecord()} disabled={!executionDirty}>
                保存草稿
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => saveExecutionRecord("submitted")}
                disabled={plan.status !== "draft" || !executionNotEmpty}
              >
                提交待点评
              </button>
            </div>
          )}
          <hr />
          <ReviewList
            planId={planId}
            lessonIndex={n}
            sectionKey="EXECUTION_RECORD"
            embedded
            planContentVersionAt={plan.contentVersionAt}
            segmentVersionAt={plan.segmentVersionAt}
          />
        </div>
      );
    }

    if (selected.type === "executionDoc") {
      const n = selected.key;
      return (
        <div className="pl-card">
          <div className="mb-2">
            <h6 className="mb-0">课程实施文件 · 课时 {n}</h6>
          </div>
          <LessonExecutionDocPanel
            planId={planId}
            lessonIndex={n}
            plan={plan}
            canEdit={canEditPlan}
            onUploadComplete={onUploadComplete}
          />
        </div>
      );
    }

    if (selected.type === "execution") {
      const n = selected.key;
      return (
        <div className="pl-card">
          <h6>支撑材料 · 课时 {n}</h6>
          <LessonFileManager planId={planId} lessonIndex={n} canEdit={canEditPlan} canDownload={canDownloadPlan} />
        </div>
      );
    }

    if (selected.type === "executionReviews") {
      return (
        <div className="pl-card">
          <h6>实施整体点评</h6>
          <ReviewList
            planId={planId}
            lessonIndex={null}
            sectionLabels={planSectionLabels}
            aggregateScope="implementation"
            embedded
            planContentVersionAt={plan.contentVersionAt}
            segmentVersionAt={plan.segmentVersionAt}
            canTriggerAi={canEditPlan}
            aiPending={aiReviewPending.implementation}
            setAiPending={(v) => setAiReviewPending((prev) => ({ ...prev, implementation: v }))}
            onSelectSection={(key, lessonIdx) =>
              key === "LESSON_DESIGN"
                ? select("planLesson", lessonIdx)
                : key === "EXECUTION_RECORD"
                ? select("executionRecord", lessonIdx)
                : key === "DESIGN_OVERALL"
                ? select("plan", "reviews")
                : select("planSection", key.toLowerCase())
            }
          />
        </div>
      );
    }

    if (selected.type === "admin") {
      return (
        <div className="pl-card">
          <h6>管理员操作</h6>
          <div className="form-group">
            <label>优秀案例</label>
            <div>
              <button className="btn btn-outline-primary btn-sm" type="button" onClick={toggleExcellent}>
                {plan.isExcellentCase ? "取消优秀案例标记" : "设为优秀案例"}
              </button>
            </div>
          </div>
          <div className="form-group mb-0">
            <label>停用状态</label>
            <div>
              <button className="btn btn-outline-secondary btn-sm" type="button" onClick={toggleSuspend}>
                {plan.suspended ? "启用" : "停用"}
              </button>
            </div>
          </div>
          {/* 管理员备注 (curatorNote) retired -- it duplicated 管理员点评 (see
              整体点评/WHY/WHAT/HOW's ReviewList, reviewerType='admin') with
              none of its benefits (no history, no attribution, and it was
              leaking to any viewer via the plan API despite the UI only
              ever showing it here). Leave a 管理员点评 review instead. */}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="container pl-page">
      {/* Covers 返回 above (a plain history.push) and browser back/forward
          while still on this route -- actual tab close/refresh is the
          beforeunload listener set up above instead. */}
      <Prompt when={planDirty || executionDirty || metaDirty} message="有未保存的内容，确定要离开吗？" />
      <div className="pl-hero">
        <div className="mb-2">
          <button type="button" className="btn btn-primary" onClick={goBack}>
            返回
          </button>
        </div>
        <h4 className="pl-title">
          {plan.title}
          {plan.suspended && <span className="pl-tag pl-tag-warn ml-2">已停用</span>}
        </h4>
        <p className="pl-subtitle">
          {plan.theme || "-"} · {plan.grade || "-"} · {plan.year} · 状态：{PLAN_STATUS_LABELS[plan.status] || plan.status}
          {plan.isExcellentCase ? " · 优秀案例" : ""}
        </p>
        {plan.suspended && !isAdmin && (
          <div className="alert alert-warning py-2 mb-0">该课程设计已被管理员停用，如需修改请联系管理员。</div>
        )}
      </div>

      <div className="pl-explorer">
        {/* Hide/show the whole nav panel -- distinct from each 计划/实施 group's own
            expand/collapse chevron below. When hidden, the nav is removed entirely
            (not just shrunk) and this handle is the only remaining trace of it. */}
        <button
          type="button"
          className="pl-explorer-hide-toggle"
          onClick={() => setNavCollapsed((prev) => !prev)}
          title={navCollapsed ? "显示导航" : "隐藏导航"}
        >
          <i className={`fas fa-${navCollapsed ? "angle-double-right" : "angle-double-left"}`}></i>
        </button>

        {!navCollapsed && (
          <div className="pl-explorer-nav">
            <div className="pl-explorer-group">
              <button
                type="button"
                className="pl-explorer-folder"
                onClick={() => {
                  toggleGroup("plan");
                  // 计划 itself has no content of its own -- unlike the other
                  // structural headers (which go blank), clicking it shows
                  // 课程设计文件 directly, matching the 课时N -> 实施记录
                  // shortcut just below in the 实施 group; 课程设计文件 is no
                  // longer its own leaf (see the filtered leaf list below).
                  select("plan", "files");
                }}
              >
                <i className={`fas fa-chevron-${expandedGroups.plan ? "down" : "right"} pl-explorer-chevron`}></i>
                <i className="fas fa-folder-open pl-folder-icon mr-1"></i> 计划
              </button>
              {expandedGroups.plan && (
                <div className="pl-explorer-children">
                  <button
                    type="button"
                    className={`pl-explorer-leaf ${selected.type === "plan" && selected.key === "basic" ? "is-active" : ""}`}
                    onClick={() => select("plan", "basic")}
                  >
                    基本信息
                  </button>
                  {/* WHY/WHAT/HOW-equivalent leaves, one per anchoring-level
                      section (see anchorSections and the "planSection"
                      render branch above) -- NOT one per top-level
                      schema.sections entry, which for a heading-parsed
                      template collapses to a single uninformative wrapper
                      (e.g. "课程设计框架") instead of surfacing WHY/WHAT/HOW as
                      their own pages. Online-only, like 分课时设计 just below
                      (an upload-mode plan has no online form to fill in). */}
                  {plan.planMode === "online" &&
                    planAnchorSections.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        className={`pl-explorer-leaf ${selected.type === "planSection" && selected.key === s.key ? "is-active" : ""}`}
                        onClick={() => select("planSection", s.key)}
                      >
                        {s.label}
                      </button>
                    ))}
                  {/* 第二部分：分课时设计 -- part of the design document (see the
                      planLesson render branch above), so nested here under 计划
                      rather than a sibling of 实施's own 课时 list. Online-only,
                      matching WHY/WHAT/HOW just above. */}
                  {plan.planMode === "online" && (
                    <div className="pl-explorer-subgroup">
                      <button
                        type="button"
                        className="pl-explorer-folder pl-explorer-subfolder"
                        onClick={() => {
                          toggleGroup("planLessons");
                          select("none");
                        }}
                      >
                        <i className={`fas fa-chevron-${expandedGroups.planLessons ? "down" : "right"} pl-explorer-chevron`}></i>
                        分课时设计
                      </button>
                      {expandedGroups.planLessons && (
                        <div className="pl-explorer-children pl-explorer-children-nested">
                          {lessons.map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={`pl-explorer-leaf ${selected.type === "planLesson" && selected.key === n ? "is-active" : ""}`}
                              onClick={() => select("planLesson", n)}
                            >
                              课时 {n}
                            </button>
                          ))}
                          {lessons.length === 0 && <div className="pl-explorer-empty">尚未设置预计课时</div>}
                        </div>
                      )}
                    </div>
                  )}
                  {/* 课程设计文件 ("files") is no longer its own leaf -- clicking
                      计划's own header shows it directly (see that button's
                      onClick above). */}
                  {PLAN_SECTIONS.filter((s) => s.key === "reviews").map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className={`pl-explorer-leaf ${selected.type === "plan" && selected.key === s.key ? "is-active" : ""}`}
                      onClick={() => select("plan", s.key)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="pl-explorer-group">
              <button
                type="button"
                className="pl-explorer-folder"
                onClick={() => {
                  toggleGroup("execution");
                  select("none");
                }}
              >
                <i className={`fas fa-chevron-${expandedGroups.execution ? "down" : "right"} pl-explorer-chevron`}></i>
                <i className="fas fa-folder-open pl-folder-icon mr-1"></i> 实施
              </button>
              {expandedGroups.execution && (
                <div className="pl-explorer-children">
                  {/* Each 课时N is its own subgroup (same shape as 分课时设计's
                      above): 实施记录 (the online-fill form, with its own
                      embedded 点评 block -- see the executionRecord render
                      branch above), 课程实施文件 (its on-the-fly 上传/下载/
                      预览 doc panel, mirroring 课程设计文件), then 支撑材料
                      (LessonFileManager). No key seeding needed for the
                      dynamic `exec_${n}` toggle -- expandedGroups[key] reads
                      as collapsed (falsy) for any key not yet clicked. */}
                  {lessons.map((n) => (
                    <div className="pl-explorer-subgroup" key={n}>
                      <button
                        type="button"
                        className="pl-explorer-folder pl-explorer-subfolder"
                        onClick={() => {
                          toggleGroup(`exec_${n}`);
                          // 课时N itself has no content of its own -- unlike the other
                          // structural headers above (which just go blank), clicking
                          // this one shows 课程实施文件 directly, matching 计划's own
                          // header -> 课程设计文件 shortcut; 课程实施文件 is no longer
                          // its own leaf (see the leaf list below).
                          select("executionDoc", n);
                        }}
                      >
                        <i className={`fas fa-chevron-${expandedGroups[`exec_${n}`] ? "down" : "right"} pl-explorer-chevron`}></i>
                        课时 {n}
                      </button>
                      {expandedGroups[`exec_${n}`] && (
                        <div className="pl-explorer-children pl-explorer-children-nested">
                          <button
                            type="button"
                            className={`pl-explorer-leaf ${selected.type === "executionRecord" && selected.key === n ? "is-active" : ""}`}
                            onClick={() => select("executionRecord", n)}
                          >
                            实施记录
                          </button>
                          <button
                            type="button"
                            className={`pl-explorer-leaf ${selected.type === "execution" && selected.key === n ? "is-active" : ""}`}
                            onClick={() => select("execution", n)}
                          >
                            支撑材料
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {lessons.length === 0 && <div className="pl-explorer-empty">尚未设置预计课时</div>}
                  {/* 实施 section review, as a sibling of the 课时N subgroups --
                      mirrors 计划's own "reviews" leaf above, but aggregates
                      segment reviews from both 设计 and 实施 (see the
                      executionReviews render branch above and
                      review-list.component.js's aggregateScope prop). */}
                  <button
                    type="button"
                    className={`pl-explorer-leaf ${selected.type === "executionReviews" ? "is-active" : ""}`}
                    onClick={() => select("executionReviews")}
                  >
                    实施整体点评
                  </button>
                </div>
              )}
            </div>

            {isAdmin && (
              <button
                type="button"
                className={`pl-explorer-leaf pl-explorer-top-leaf ${selected.type === "admin" ? "is-active" : ""}`}
                onClick={() => select("admin")}
              >
                <i className="fas fa-cog mr-1"></i> 管理
              </button>
            )}
          </div>
        )}

        <div className="pl-explorer-content">
          {message && <div className="alert alert-info py-2">{message}</div>}
          {renderContent()}
        </div>
      </div>
    </div>
  );
};

export default PlanDetail;
