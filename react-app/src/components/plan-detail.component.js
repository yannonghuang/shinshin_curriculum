import React, { useCallback, useEffect, useRef, useState } from "react";
import mammoth from "mammoth/mammoth.browser";
import { Tab, TabList, TabPanel, Tabs } from "react-tabs";
import "react-tabs/style/react-tabs.css";

import PlanDataService from "../services/plan.service";
import ArtifactDataService from "../services/artifact.service";
import AuthService from "../services/auth.service";
import ReviewList from "./review-list.component";
import { PLAN_THEMES, PLAN_GRADES, ARTIFACT_CATEGORIES_LESSON_LEVEL } from "../constants/plan-options";
import "../curriculum.css";

const emptyWhyWhatHow = {
  why: {
    cognitiveGoals: "",
    practicalGoals: "",
    socialEmotionalGoals: "",
    otherGoals: "",
  },
  what: {
    projectIntro: "",
    drivingQuestion: "",
    finalOutcomePersonal: "",
    finalOutcomeTeam: "",
    publicDisplayMethod: "",
  },
  how: {
    entryActivity: "",
    teacherStudentDiscussion: "",
    outcomeDisplayDiscussion: "",
    requirementsChecklist: "",
    knowledgeExploration: "",
    productMaking: "",
    reflectionIteration: "",
    finalOutcomeDisplay: "",
    reflectionSummary: "",
    materialsNeeded: "",
    resourcesNeeded: "",
  },
};

const mergeFormData = (data) => ({
  why: { ...emptyWhyWhatHow.why, ...(data && data.why) },
  what: { ...emptyWhyWhatHow.what, ...(data && data.what) },
  how: { ...emptyWhyWhatHow.how, ...(data && data.how) },
});

// Embedded artifact upload/list panel, reused for both the plan-level "课程设计文件" upload
// (lessonIndex=null) and each per-课时 "实施记录文件/课件PPT/图片/视频" tab. Migrated from
// shinshin's case-detail.component.js: single-file upload w/ progress bar, category-folder
// drag/drop multi-upload, bulk-zip upload, and docx(mammoth)/pdf/image/video/audio preview.
// planUpdatedAt (optional): when provided, any 课程设计文件 artifact generated/uploaded
// before the plan's last edit is flagged "内容已更新，文档可能已过时" -- the doc's content
// is derived from planFormData at generation time and doesn't auto-regenerate on later edits.
const ArtifactPanel = ({ planId, lessonIndex, categories, allowBulk, canEdit, planUpdatedAt }) => {
  const [artifacts, setArtifacts] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(categories[0]);
  const [singleForm, setSingleForm] = useState({ description: "", category: categories[0], file: null });
  const [bulkZipFile, setBulkZipFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [bulkUploadProgress, setBulkUploadProgress] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadingBulk, setIsUploadingBulk] = useState(false);
  const [message, setMessage] = useState("");
  const [dragUploadCategory, setDragUploadCategory] = useState("");
  const [pendingCategoryFiles, setPendingCategoryFiles] = useState([]);
  const categoryFileInputRef = useRef(null);
  const previewRef = useRef(null);
  const [previewArtifact, setPreviewArtifact] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMime, setPreviewMime] = useState("");
  const [previewDocxHtml, setPreviewDocxHtml] = useState("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const retrieveArtifacts = useCallback(async () => {
    try {
      const resp = await ArtifactDataService.getByPlan(planId, lessonIndex);
      const list = Array.isArray(resp.data) ? resp.data : resp.data.rows || resp.data.artifacts || [];
      setArtifacts(list);
    } catch (e) {
      console.log(e);
      setMessage("加载附件列表失败。");
    }
  }, [planId, lessonIndex]);

  useEffect(() => {
    retrieveArtifacts();
  }, [retrieveArtifacts]);

  useEffect(() => {
    return () => {
      if (previewUrl) window.URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const uploadSingle = async (e) => {
    e.preventDefault();
    setMessage("");
    if (!singleForm.file) {
      setMessage("请先选择文件。");
      return;
    }
    const formData = new FormData();
    formData.append("description", singleForm.description || "");
    formData.append("category", singleForm.category || categories[0]);
    if (lessonIndex !== undefined && lessonIndex !== null) formData.append("lessonIndex", lessonIndex);
    formData.append("file", singleForm.file);
    try {
      setIsUploading(true);
      setUploadProgress(0);
      await ArtifactDataService.create(planId, formData, (event) => {
        if (!event || !event.total) return;
        setUploadProgress(Math.min(100, Math.round((event.loaded * 100) / event.total)));
      });
      setSingleForm({ description: "", category: categories[0], file: null });
      setMessage("附件上传成功。");
      retrieveArtifacts();
    } catch (err) {
      setMessage(err?.response?.data?.message || "上传失败。");
    } finally {
      setIsUploading(false);
      setTimeout(() => setUploadProgress(null), 600);
    }
  };

  const uploadCategoryFiles = async (files, category) => {
    if (!files || files.length === 0) {
      setMessage("请先选择或拖入文件。");
      return;
    }
    setMessage("");
    setIsUploading(true);
    setUploadProgress(0);
    try {
      for (let index = 0; index < files.length; index += 1) {
        const formData = new FormData();
        formData.append("description", "");
        formData.append("category", category);
        if (lessonIndex !== undefined && lessonIndex !== null) formData.append("lessonIndex", lessonIndex);
        formData.append("file", files[index]);
        await ArtifactDataService.create(planId, formData);
        setUploadProgress(Math.round(((index + 1) * 100) / files.length));
      }
      setPendingCategoryFiles([]);
      if (categoryFileInputRef.current) categoryFileInputRef.current.value = "";
      setMessage(`已上传 ${files.length} 个文件到 ${category}。`);
      retrieveArtifacts();
    } catch (err) {
      setMessage(err?.response?.data?.message || "分类上传失败。");
    } finally {
      setIsUploading(false);
      setDragUploadCategory("");
      setTimeout(() => setUploadProgress(null), 600);
    }
  };

  const onCategoryFilesPicked = (e) => {
    const files = Array.from(e.target.files || []);
    setPendingCategoryFiles(files);
    if (files.length > 0) setMessage(`已选择 ${files.length} 个文件，请点击下面的分类文件夹上传。`);
  };

  const uploadBulkZip = async (e) => {
    e.preventDefault();
    setMessage("");
    if (!bulkZipFile) {
      setMessage("请先选择 zip 文件。");
      return;
    }
    const formData = new FormData();
    formData.append("file", bulkZipFile);
    if (lessonIndex !== undefined && lessonIndex !== null) formData.append("lessonIndex", lessonIndex);
    try {
      setIsUploadingBulk(true);
      setBulkUploadProgress(0);
      const resp = await ArtifactDataService.bulkCreate(planId, formData, (event) => {
        if (!event || !event.total) return;
        setBulkUploadProgress(Math.min(100, Math.round((event.loaded * 100) / event.total)));
      });
      const created = resp?.data?.createdCount || 0;
      const skipped = resp?.data?.skippedCount || 0;
      setBulkUploadProgress(100);
      setMessage(`批量上传完成：成功 ${created}，跳过 ${skipped}。`);
      setBulkZipFile(null);
      retrieveArtifacts();
    } catch (err) {
      setMessage(err?.response?.data?.message || "批量上传失败。");
    } finally {
      setIsUploadingBulk(false);
      setTimeout(() => setBulkUploadProgress(null), 800);
    }
  };

  const downloadArtifact = async (artifact) => {
    try {
      const resp = await ArtifactDataService.download(artifact.id);
      const url = window.URL.createObjectURL(new Blob([resp.data], { type: artifact.attachmentMime || "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", artifact.attachmentName || `artifact-${artifact.id}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      console.log(e);
      setMessage("下载失败。");
    }
  };

  const previewArtifactContent = async (artifact) => {
    try {
      setIsPreviewLoading(true);
      if (previewUrl) window.URL.revokeObjectURL(previewUrl);
      setPreviewDocxHtml("");
      const resp = await ArtifactDataService.download(artifact.id);
      const mime = artifact.attachmentMime || "application/octet-stream";
      const ext = (artifact.attachmentName || "").toLowerCase().split(".").pop();
      if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const result = await mammoth.convertToHtml({ arrayBuffer: resp.data });
        setPreviewArtifact(artifact);
        setPreviewMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        setPreviewDocxHtml(result.value || "<p>文档内容为空。</p>");
        setPreviewUrl("");
      } else {
        const url = window.URL.createObjectURL(new Blob([resp.data], { type: mime }));
        setPreviewArtifact(artifact);
        setPreviewMime(mime);
        setPreviewUrl(url);
      }
      setTimeout(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 0);
    } catch (e) {
      console.log(e);
      setMessage("预览失败。若为 .doc 文件，请使用下载。");
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const closePreview = () => {
    if (previewUrl) window.URL.revokeObjectURL(previewUrl);
    setPreviewArtifact(null);
    setPreviewUrl("");
    setPreviewMime("");
    setPreviewDocxHtml("");
  };

  const deleteArtifact = async (artifact) => {
    if (!window.confirm("此操作将永久删除该附件，且无法撤销。确定继续吗？")) return;
    try {
      await ArtifactDataService.delete(artifact.id, true);
      setMessage("附件删除成功。");
      retrieveArtifacts();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    }
  };

  const filtered = artifacts.filter((a) => categories.includes(a.category) && (categories.length === 1 || a.category === selectedCategory));

  return (
    <div>
      {canEdit && (
        <div className="pl-card">
          {allowBulk && (
            <>
              <h6>批量上传 zip</h6>
              <p className="text-muted mb-2">zip 内子目录名对应分类：{categories.join("、")}。</p>
              <form onSubmit={uploadBulkZip}>
                <div className="form-row">
                  <div className="form-group col-md-9">
                    <input className="form-control" type="file" accept=".zip,application/zip" onChange={(e) => setBulkZipFile(e.target.files[0] || null)} disabled={isUploadingBulk} />
                  </div>
                  <div className="form-group col-md-3">
                    <button className="btn btn-primary btn-block" type="submit" disabled={isUploadingBulk}>
                      {isUploadingBulk ? "上传中..." : "批量上传"}
                    </button>
                  </div>
                </div>
                {bulkUploadProgress !== null && (
                  <div className="pl-progress-wrap">
                    <div className="progress">
                      <div className="progress-bar progress-bar-striped progress-bar-animated bg-info" style={{ width: `${bulkUploadProgress}%` }}>
                        {bulkUploadProgress}%
                      </div>
                    </div>
                  </div>
                )}
              </form>
              <hr />
            </>
          )}

          <h6>单个文件上传</h6>
          <form onSubmit={uploadSingle}>
            <div className="form-row">
              <div className="form-group col-md-3">
                <label>分类</label>
                <select className="form-control" value={singleForm.category} onChange={(e) => setSingleForm((prev) => ({ ...prev, category: e.target.value }))}>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group col-md-3">
                <label>描述</label>
                <input className="form-control" value={singleForm.description} onChange={(e) => setSingleForm((prev) => ({ ...prev, description: e.target.value }))} />
              </div>
              <div className="form-group col-md-3">
                <label>文件</label>
                <input className="form-control" type="file" onChange={(e) => setSingleForm((prev) => ({ ...prev, file: e.target.files[0] || null }))} disabled={isUploading} />
              </div>
            </div>
            <button className="btn btn-primary" type="submit" disabled={isUploading}>
              {isUploading ? "上传中..." : "上传"}
            </button>
            {uploadProgress !== null && (
              <div className="pl-progress-wrap mt-2">
                <div className="progress">
                  <div className="progress-bar progress-bar-striped progress-bar-animated" style={{ width: `${uploadProgress}%` }}>
                    {uploadProgress}%
                  </div>
                </div>
              </div>
            )}
          </form>

          {categories.length > 1 && (
            <>
              <hr />
              <h6>按类别多文件上传（可拖拽）</h6>
              <input ref={categoryFileInputRef} type="file" multiple className="d-none" onChange={onCategoryFilesPicked} disabled={isUploading} />
              <div className="pl-upload-toolbar">
                <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => categoryFileInputRef.current && categoryFileInputRef.current.click()} disabled={isUploading}>
                  选择文件
                </button>
                <span className="text-muted">{pendingCategoryFiles.length > 0 ? `已选 ${pendingCategoryFiles.length} 个文件` : "未选择文件"}</span>
              </div>
              <div className="pl-folder-row">
                {categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    className={`pl-folder-btn pl-drop-folder ${dragUploadCategory === category ? "is-dragover" : ""}`}
                    onClick={() => uploadCategoryFiles(pendingCategoryFiles, category)}
                    onDragOver={(e) => { e.preventDefault(); if (!isUploading) setDragUploadCategory(category); }}
                    onDragLeave={() => setDragUploadCategory((prev) => (prev === category ? "" : prev))}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setDragUploadCategory("");
                      if (isUploading) return;
                      await uploadCategoryFiles(Array.from(e.dataTransfer?.files || []), category);
                    }}
                    disabled={isUploading}
                  >
                    {category}
                    <span className="pl-folder-hint">拖拽到这里，或点击上传已选文件</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {message && <div className="alert alert-info py-2">{message}</div>}

      {categories.length > 1 && (
        <div className="pl-folder-row mb-2">
          {categories.map((category) => (
            <button key={category} type="button" className={`pl-folder-btn ${selectedCategory === category ? "is-active" : ""}`} onClick={() => setSelectedCategory(category)}>
              {category}
            </button>
          ))}
        </div>
      )}

      <div className="pl-table-wrap">
        <table className="table table-sm table-bordered">
          <thead>
            <tr>
              <th>文件名</th>
              <th>类型</th>
              <th>描述</th>
              <th>大小(bytes)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((artifact) => {
              const isStaleDoc =
                artifact.category === "课程设计文件" &&
                planUpdatedAt &&
                artifact.createdAt &&
                new Date(planUpdatedAt) > new Date(artifact.createdAt);
              return (
              <tr key={artifact.id}>
                <td>
                  {artifact.attachmentName}
                  {isStaleDoc && <span className="pl-tag pl-tag-warn ml-2">内容已更新，文档可能已过时</span>}
                </td>
                <td>{artifact.type}</td>
                <td>{artifact.description}</td>
                <td>{artifact.attachmentSize}</td>
                <td>
                  <button className="btn btn-link p-0 mr-2" onClick={() => previewArtifactContent(artifact)}>
                    预览
                  </button>
                  <button className="btn btn-link p-0 mr-2" onClick={() => downloadArtifact(artifact)}>
                    下载
                  </button>
                  {canEdit && (
                    <button className="btn btn-link p-0 text-danger" onClick={() => deleteArtifact(artifact)}>
                      删除
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan="5" className="pl-empty">
                  暂无附件
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {previewArtifact && (
        <div ref={previewRef} className="pl-card mt-3">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <h6 className="mb-0">附件预览：{previewArtifact.attachmentName}</h6>
            <button className="btn btn-sm btn-outline-secondary" onClick={closePreview}>
              关闭预览
            </button>
          </div>
          {isPreviewLoading ? (
            <div>预览加载中...</div>
          ) : (
            <>
              {previewMime.startsWith("image/") && <img src={previewUrl} alt="artifact-preview" style={{ maxWidth: "100%" }} />}
              {previewMime.includes("pdf") && <iframe title="artifact-pdf-preview" src={previewUrl} style={{ width: "100%", height: "600px" }} />}
              {previewMime.startsWith("video/") && <video controls src={previewUrl} style={{ width: "100%" }} />}
              {previewMime.startsWith("audio/") && <audio controls src={previewUrl} style={{ width: "100%" }} />}
              {previewMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && (
                <div className="pl-docx-preview border rounded p-3 bg-white">
                  <div dangerouslySetInnerHTML={{ __html: previewDocxHtml }} />
                </div>
              )}
              {!previewMime.startsWith("image/") &&
                !previewMime.includes("pdf") &&
                !previewMime.startsWith("video/") &&
                !previewMime.startsWith("audio/") &&
                previewMime !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && <div>当前文件类型不支持内嵌预览，请使用下载。</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
};

// Migrated from shinshin's case-detail.component.js, with the online-fill WHY/WHAT/HOW form
// (matching curriculum_template/乡土课程设计方案模版.docx's structure), a react-tabs 课时
// 1..N block (pattern migrated from school.component.js's "embed child list per tab" usage),
// each lesson tab embedding its own ArtifactPanel + ReviewList.
const PlanDetail = (props) => {
  const planId = props.match.params.id;
  const [plan, setPlan] = useState(null);
  const [isLoadingPlan, setIsLoadingPlan] = useState(true);
  const [message, setMessage] = useState("");
  const [metaForm, setMetaForm] = useState(null);
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [formData, setFormData] = useState(emptyWhyWhatHow);
  const [isGeneratingDoc, setIsGeneratingDoc] = useState(false);
  const [curatorNote, setCuratorNote] = useState("");

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
  // Staleness of the generated doc / existing reviews relative to later edits
  // is now surfaced as an "out of sync" badge instead (see planUpdatedAt below).
  // Editing a plan's content is owner-only, no admin bypass -- managers can
  // suspend/promote/leave notes (see the 管理员操作 card below) but not edit
  // case content, even one they don't own (matches plan.controller.js#update
  // and #generateDoc, which enforce the same rule server-side). A suspended
  // plan is additionally locked against edits even for its owner, until an
  // admin unsuspends it.
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

  const generateDoc = async () => {
    setIsGeneratingDoc(true);
    setMessage("");
    try {
      await PlanDataService.generateDoc(planId);
      setMessage("课程设计文件已生成，可在下方“课程设计文件”列表中下载。");
    } catch (err) {
      setMessage(err?.response?.data?.message || "生成课程设计文件失败。");
    } finally {
      setIsGeneratingDoc(false);
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

      <div className="pl-card">
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

      {isAdmin && (
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
      )}

      {message && <div className="alert alert-info py-2">{message}</div>}

      {plan.planMode === "online" ? (
        <div className="pl-card pl-why-what-how">
          <div className="d-flex justify-content-between align-items-center">
            <h5 className="mb-0">课程设计方案（WHY / WHAT / HOW）</h5>
            <button className="btn btn-outline-primary btn-sm" type="button" onClick={generateDoc} disabled={isGeneratingDoc}>
              {isGeneratingDoc ? "生成中..." : "生成课程设计文件"}
            </button>
          </div>

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
          <h6>课程设计文件</h6>
          <ArtifactPanel
            planId={planId}
            lessonIndex={null}
            categories={["课程设计文件"]}
            allowBulk={false}
            canEdit={canEditPlan}
            planUpdatedAt={plan.updatedAt}
          />
        </div>
      ) : (
        <div className="pl-card">
          <h5>课程设计文件（上传）</h5>
          <ArtifactPanel planId={planId} lessonIndex={null} categories={["课程设计文件"]} allowBulk={false} canEdit={canEditPlan} />
        </div>
      )}

      <div className="pl-card">
        <h5>整体点评</h5>
        <ReviewList planId={planId} lessonIndex={null} embedded planUpdatedAt={plan.updatedAt} />
      </div>

      {lessonCount > 0 && (
        <div className="pl-card">
          <h5>分课时实施记录</h5>
          <Tabs className="pl-lesson-tabs mt-2">
            <TabList>
              {lessons.map((n) => (
                <Tab key={n}>课时 {n}</Tab>
              ))}
            </TabList>
            {lessons.map((n) => (
              <TabPanel key={n}>
                <ArtifactPanel planId={planId} lessonIndex={n} categories={ARTIFACT_CATEGORIES_LESSON_LEVEL} allowBulk canEdit={canEditPlan} />
                <ReviewList planId={planId} lessonIndex={n} embedded planUpdatedAt={plan.updatedAt} />
              </TabPanel>
            ))}
          </Tabs>
        </div>
      )}
    </div>
  );
};

export default PlanDetail;
