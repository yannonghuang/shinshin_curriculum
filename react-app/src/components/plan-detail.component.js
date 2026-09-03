import React, { useCallback, useEffect, useRef, useState } from "react";
import mammoth from "mammoth/mammoth.browser";

import PlanDataService from "../services/plan.service";
import AuthService from "../services/auth.service";
import ReviewList from "./review-list.component";
import LessonFileManager from "./lesson-file-manager.component";
import { PLAN_THEMES, PLAN_GRADES, EMPTY_WHY_WHAT_HOW, EMPTY_LESSON } from "../constants/plan-options";
import { extractWhyWhatHowFromText, extractLessonsFromText, buildPlanFormData } from "../utils/planDocExtract";
import "../curriculum.css";

const mergeFormData = (data) => ({
  why: { ...EMPTY_WHY_WHAT_HOW.why, ...(data && data.why) },
  what: { ...EMPTY_WHY_WHAT_HOW.what, ...(data && data.what) },
  how: { ...EMPTY_WHY_WHAT_HOW.how, ...(data && data.how) },
  lessons: Array.isArray(data && data.lessons) ? data.lessons : [],
});

// Plan-level 课程设计文件 panel, reached from a single sidebar leaf (see
// PLAN_SECTIONS_ONLINE/UPLOAD below). All three commands are shown at once:
// 下载/预览 act immediately on click; 上传 just toggles the drop-zone/browse
// UI open rather than acting itself, since it needs a file first. Nothing is
// materialized server-side for any of the three -- 下载/预览 both hit
// GET /plans/:id/design-doc (plan.controller.js#renderDoc), which renders the
// plan's *current* content into a .docx on the fly and streams it back, so
// there's no generated copy to go stale or to clean up; 上传 parses a
// dropped/picked .docx client-side (the same best-effort extraction
// plans-list.component.js's "从文件导入" uses to seed a brand-new plan, see
// utils/planDocExtract.js) and overwrites the plan's planFormData wholesale
// after an explicit confirm -- a destructive action, so it's gated behind a
// warning rather than a silent merge.
const DesignDocPanel = ({ planId, plan, canEdit, onContentReplaced }) => {
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
      const arrayBuffer = await file.arrayBuffer();
      const [textResult, htmlResult] = await Promise.all([
        mammoth.extractRawText({ arrayBuffer }),
        mammoth.convertToHtml({ arrayBuffer }),
      ]);
      const text = textResult.value || "";
      const html = htmlResult.value || "";

      const bodyExtracted = extractWhyWhatHowFromText(text, html);
      const lessons = extractLessonsFromText(text);
      if (Object.keys(bodyExtracted).length === 0 && lessons.length === 0) {
        setMessage("未能从文件中识别到有效内容，请确认文件是按课程设计方案模版填写的 .docx。");
        return;
      }
      const newFormData = buildPlanFormData(bodyExtracted, lessons);
      await PlanDataService.update(planId, { planFormData: newFormData });
      setMessage("课程设计文件已上传，在线内容已更新。");
      setShowUpload(false);
      if (onContentReplaced) onContentReplaced();
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

// Migrated from shinshin's case-detail.component.js, with the online-fill WHY/WHAT/HOW form
// (matching curriculum_template/乡土课程设计方案模版.docx's structure). Layout: a file-explorer
// style split -- a collapsible left nav tree (计划/its sections, 实施/its 课时 segments each
// admin-only 管理 leaf) drives a single-section content pane on the right, replacing the old
// waterfall of every card stacked vertically (and the react-tabs 课时 block) with one section
// visible at a time.
const PLAN_SECTIONS_ONLINE = [
  { key: "basic", label: "基本信息" },
  { key: "why", label: "WHY · 学习目标" },
  { key: "what", label: "WHAT · 项目简介" },
  { key: "how", label: "HOW · 活动设计" },
  { key: "files", label: "课程设计文件" },
  { key: "reviews", label: "整体点评" },
];
const PLAN_SECTIONS_UPLOAD = [
  { key: "basic", label: "基本信息" },
  { key: "files", label: "课程设计文件" },
  { key: "reviews", label: "整体点评" },
];

const PlanDetail = (props) => {
  const planId = props.match.params.id;
  const [plan, setPlan] = useState(null);
  const [isLoadingPlan, setIsLoadingPlan] = useState(true);
  const [message, setMessage] = useState("");
  const [metaForm, setMetaForm] = useState(null);
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [formData, setFormData] = useState({ ...EMPTY_WHY_WHAT_HOW, lessons: [] });
  const [curatorNote, setCuratorNote] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(false);
  // planLessons (分课时设计, nested under 计划) starts collapsed, unlike plan/
  // execution -- it can hold as many leaves as 实施's own 课时 list, and it's
  // one level deeper, so expanding it by default would make the plan section
  // of the sidebar as tall as the whole 实施 tree before a teacher's even
  // looked at it.
  const [expandedGroups, setExpandedGroups] = useState({ plan: true, execution: true, planLessons: false });
  const [selected, setSelected] = useState({ type: "plan", key: "basic" });

  const toggleGroup = (name) => setExpandedGroups((prev) => ({ ...prev, [name]: !prev[name] }));
  const select = (type, key) => setSelected({ type, key });

  const retrievePlan = useCallback(async () => {
    setIsLoadingPlan(true);
    try {
      const resp = await PlanDataService.get(planId);
      setPlan(resp.data);
      setFormData(mergeFormData(resp.data.planFormData));
      setCuratorNote(resp.data.curatorNote || "");
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

  const goBack = () => props.history.push("/plans");

  const startEditMeta = () => {
    setMetaForm({
      title: plan.title || "",
      theme: plan.theme || "",
      grade: plan.grade || "",
      year: plan.year ? String(plan.year) : "",
      plannedLessonCount: plan.plannedLessonCount ? String(plan.plannedLessonCount) : "",
    });
    setIsEditingMeta(true);
  };

  const saveMeta = async (e) => {
    e.preventDefault();
    try {
      await PlanDataService.update(planId, {
        title: metaForm.title,
        theme: metaForm.theme || null,
        grade: metaForm.grade || null,
        year: Number(metaForm.year),
        plannedLessonCount: metaForm.plannedLessonCount ? Number(metaForm.plannedLessonCount) : null,
      });
      setIsEditingMeta(false);
      setMessage("课程设计信息已更新。");
      retrievePlan();
    } catch (err) {
      setMessage(err?.response?.data?.message || "更新失败。");
    }
  };

  const onFormFieldChange = (section, field, value) => {
    setFormData((prev) => ({ ...prev, [section]: { ...prev[section], [field]: value } }));
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
  };

  const saveFormData = async (submitStatus) => {
    try {
      await PlanDataService.update(planId, {
        planFormData: formData,
        status: submitStatus || undefined,
      });
      setMessage(submitStatus === "submitted" ? "课程设计方案已提交。" : "课程设计方案已保存。");
      retrievePlan();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存失败。");
    }
  };

  const saveCurator = async () => {
    try {
      await PlanDataService.update(planId, { curatorNote });
      setMessage("管理员备注已保存。");
      retrievePlan();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存失败。");
    }
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
  const planSections = plan.planMode === "online" ? PLAN_SECTIONS_ONLINE : PLAN_SECTIONS_UPLOAD;

  const renderContent = () => {
    if (selected.type === "plan" && selected.key === "basic") {
      return (
        <div className="pl-card">
          <h6>基本信息</h6>
          {isEditingMeta ? (
            <form onSubmit={saveMeta}>
              <div className="form-row">
                <div className="form-group col-md-4">
                  <label>标题</label>
                  <input className="form-control" value={metaForm.title} onChange={(e) => setMetaForm((p) => ({ ...p, title: e.target.value }))} required />
                </div>
                <div className="form-group col-md-2">
                  <label>年份</label>
                  <input className="form-control" type="number" value={metaForm.year} onChange={(e) => setMetaForm((p) => ({ ...p, year: e.target.value }))} required />
                </div>
                <div className="form-group col-md-3">
                  <label>乡土主题</label>
                  <select className="form-control" value={metaForm.theme} onChange={(e) => setMetaForm((p) => ({ ...p, theme: e.target.value }))}>
                    <option value="">不限</option>
                    {PLAN_THEMES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group col-md-3">
                  <label>年级</label>
                  <select className="form-control" value={metaForm.grade} onChange={(e) => setMetaForm((p) => ({ ...p, grade: e.target.value }))}>
                    <option value="">不限</option>
                    {PLAN_GRADES.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>预计课时</label>
                <input
                  className="form-control"
                  type="number"
                  min="1"
                  max="60"
                  value={metaForm.plannedLessonCount}
                  onChange={(e) => setMetaForm((p) => ({ ...p, plannedLessonCount: e.target.value }))}
                />
              </div>
              <button className="btn btn-primary mr-2" type="submit">
                保存
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setIsEditingMeta(false)}>
                取消
              </button>
            </form>
          ) : (
            <div>
              <div>
                <b>填写方式：</b>
                {plan.planMode === "online" ? "在线填写" : "上传文件"}
              </div>
              <div>
                <b>预计课时：</b>
                {plan.plannedLessonCount || "-"}
              </div>
              {canEditPlan && (
                <button className="btn btn-link p-0 mt-2" onClick={startEditMeta}>
                  编辑课程基本信息
                </button>
              )}
            </div>
          )}
        </div>
      );
    }

    if (selected.type === "plan" && selected.key === "why") {
      return (
        <div className="pl-card pl-why-what-how">
          <h6>WHY · 学习目标</h6>
          {[
            ["cognitiveGoals", "认知思维目标"],
            ["practicalGoals", "实践技能目标"],
            ["socialEmotionalGoals", "社会情感目标"],
            ["otherGoals", "其他目标"],
          ].map(([field, label]) => (
            <div className="form-group" key={field}>
              <label>{label}</label>
              <textarea
                className="form-control"
                rows="2"
                value={formData.why[field]}
                disabled={!canEditPlan}
                onChange={(e) => onFormFieldChange("why", field, e.target.value)}
              />
            </div>
          ))}
          {canEditPlan && (
            <div className="d-flex mt-2">
              <button className="btn btn-secondary mr-2" type="button" onClick={() => saveFormData()}>
                保存草稿
              </button>
              <button className="btn btn-primary" type="button" onClick={() => saveFormData("submitted")}>
                提交待点评
              </button>
            </div>
          )}
          <hr />
          <ReviewList planId={planId} lessonIndex={null} sectionKey="WHY" embedded planContentVersionAt={plan.contentVersionAt} />
        </div>
      );
    }

    if (selected.type === "plan" && selected.key === "what") {
      return (
        <div className="pl-card pl-why-what-how">
          <h6>WHAT · 项目简介</h6>
          {[
            ["projectIntro", "项目介绍（为什么做这个乡土主题？）"],
            ["drivingQuestion", "驱动问题（儿童视角）"],
            ["finalOutcomePersonal", "最终成果 · 个人成果"],
            ["finalOutcomeTeam", "最终成果 · 团队成果"],
            ["publicDisplayMethod", "公开展示方式"],
          ].map(([field, label]) => (
            <div className="form-group" key={field}>
              <label>{label}</label>
              <textarea
                className="form-control"
                rows="2"
                value={formData.what[field]}
                disabled={!canEditPlan}
                onChange={(e) => onFormFieldChange("what", field, e.target.value)}
              />
            </div>
          ))}
          {canEditPlan && (
            <div className="d-flex mt-2">
              <button className="btn btn-secondary mr-2" type="button" onClick={() => saveFormData()}>
                保存草稿
              </button>
              <button className="btn btn-primary" type="button" onClick={() => saveFormData("submitted")}>
                提交待点评
              </button>
            </div>
          )}
          <hr />
          <ReviewList planId={planId} lessonIndex={null} sectionKey="WHAT" embedded planContentVersionAt={plan.contentVersionAt} />
        </div>
      );
    }

    if (selected.type === "plan" && selected.key === "how") {
      return (
        <div className="pl-card pl-why-what-how">
          <h6>HOW · 活动设计</h6>
          {[
            ["entryActivity", "入项活动（1-2课时）"],
            ["teacherStudentDiscussion", "师生共议驱动问题"],
            ["outcomeDisplayDiscussion", "讨论最终成果及展示"],
            ["requirementsChecklist", "讨论须知清单"],
            ["knowledgeExploration", "探究与制作 · 知识探究（课时安排）"],
            ["productMaking", "探究与制作 · 产品制作（课时安排）"],
            ["reflectionIteration", "探究与制作 · 反思与迭代（课时安排）"],
            ["finalOutcomeDisplay", "出项 · 最终成果展示"],
            ["reflectionSummary", "出项 · 复盘反思"],
            ["materialsNeeded", "需要的材料"],
            ["resourcesNeeded", "需要链接的资源"],
          ].map(([field, label]) => (
            <div className="form-group" key={field}>
              <label>{label}</label>
              <textarea
                className="form-control"
                rows="2"
                value={formData.how[field]}
                disabled={!canEditPlan}
                onChange={(e) => onFormFieldChange("how", field, e.target.value)}
              />
            </div>
          ))}
          {canEditPlan && (
            <div className="d-flex mt-2">
              <button className="btn btn-secondary mr-2" type="button" onClick={() => saveFormData()}>
                保存草稿
              </button>
              <button className="btn btn-primary" type="button" onClick={() => saveFormData("submitted")}>
                提交待点评
              </button>
            </div>
          )}
          <hr />
          <ReviewList planId={planId} lessonIndex={null} sectionKey="HOW" embedded planContentVersionAt={plan.contentVersionAt} />
        </div>
      );
    }

    if (selected.type === "plan" && selected.key === "files") {
      return (
        <div className="pl-card">
          <div className="mb-2">
            <h6 className="mb-0">课程设计文件</h6>
          </div>
          <DesignDocPanel planId={planId} plan={plan} canEdit={canEditPlan} onContentReplaced={retrievePlan} />
        </div>
      );
    }

    if (selected.type === "plan" && selected.key === "reviews") {
      return (
        <div className="pl-card">
          <h6>整体点评</h6>
          <ReviewList planId={planId} lessonIndex={null} embedded planContentVersionAt={plan.contentVersionAt} canTriggerAi={canEditPlan} />
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
      // The template leaves each 课时 entirely freeform (see EMPTY_LESSON) --
      // just an optional inline title after "第N课时：" plus a body -- so
      // there's no fixed-field form here the way WHY/WHAT/HOW have one, just
      // these two. lessons is a sparse array (see onLessonFieldChange), so a
      // lesson with nothing written yet falls back to EMPTY_LESSON.
      const lesson = formData.lessons.find((l) => Number(l.index) === n) || EMPTY_LESSON;
      return (
        <div className="pl-card pl-why-what-how">
          <h6>分课时设计 · 课时 {n}</h6>
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
              rows="6"
              value={lesson.content}
              disabled={!canEditPlan}
              onChange={(e) => onLessonFieldChange(n, "content", e.target.value)}
            />
          </div>
          {canEditPlan && (
            <div className="d-flex mt-2">
              <button className="btn btn-secondary mr-2" type="button" onClick={() => saveFormData()}>
                保存草稿
              </button>
              <button className="btn btn-primary" type="button" onClick={() => saveFormData("submitted")}>
                提交待点评
              </button>
            </div>
          )}
        </div>
      );
    }

    if (selected.type === "execution") {
      const n = selected.key;
      return (
        <div className="pl-card">
          <h6>课时 {n}</h6>
          <LessonFileManager planId={planId} lessonIndex={n} canEdit={canEditPlan} />
          <hr />
          <ReviewList planId={planId} lessonIndex={n} embedded planContentVersionAt={plan.contentVersionAt} canTriggerAi={canEditPlan} />
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
          <div className="form-group">
            <label>停用状态</label>
            <div>
              <button className="btn btn-outline-secondary btn-sm" type="button" onClick={toggleSuspend}>
                {plan.suspended ? "启用" : "停用"}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label>管理员备注</label>
            <textarea className="form-control" rows="2" value={curatorNote} onChange={(e) => setCuratorNote(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-sm" type="button" onClick={saveCurator}>
            保存备注
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="container pl-page">
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
          {plan.theme || "-"} · {plan.grade || "-"} · {plan.year} · 状态：{plan.status}
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
              <button type="button" className="pl-explorer-folder" onClick={() => toggleGroup("plan")}>
                <i className={`fas fa-chevron-${expandedGroups.plan ? "down" : "right"} pl-explorer-chevron`}></i>
                <i className="fas fa-folder-open mr-1"></i> 计划
              </button>
              {expandedGroups.plan && (
                <div className="pl-explorer-children">
                  {planSections
                    .filter((s) => ["basic", "why", "what", "how"].includes(s.key))
                    .map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        className={`pl-explorer-leaf ${selected.type === "plan" && selected.key === s.key ? "is-active" : ""}`}
                        onClick={() => select("plan", s.key)}
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
                        onClick={() => toggleGroup("planLessons")}
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
                  {planSections
                    .filter((s) => ["files", "reviews"].includes(s.key))
                    .map((s) => (
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
              <button type="button" className="pl-explorer-folder" onClick={() => toggleGroup("execution")}>
                <i className={`fas fa-chevron-${expandedGroups.execution ? "down" : "right"} pl-explorer-chevron`}></i>
                <i className="fas fa-folder-open mr-1"></i> 实施
              </button>
              {expandedGroups.execution && (
                <div className="pl-explorer-children">
                  {lessons.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`pl-explorer-leaf ${selected.type === "execution" && selected.key === n ? "is-active" : ""}`}
                      onClick={() => select("execution", n)}
                    >
                      课时 {n}
                    </button>
                  ))}
                  {lessons.length === 0 && <div className="pl-explorer-empty">尚未设置预计课时</div>}
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
