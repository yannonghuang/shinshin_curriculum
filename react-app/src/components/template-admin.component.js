import React, { useCallback, useEffect, useState } from "react";
import mammoth from "mammoth";
import { Link } from "react-router-dom";
import TemplateDataService from "../services/template.service";
import PlanDataService from "../services/plan.service";
import "../curriculum.css";

const TEMPLATE_KEYS = [
  { key: "plan_design", label: "课程设计方案模板（WHY/WHAT/HOW）" },
  { key: "lesson_execution", label: "课时实施记录模板" },
];

// Recursively renders one schema section's true nested outline (section.
// subsections -- see backend/app/services/templateParser.js#parseHeadingSections)
// indented per depth, falling back to a flat field list for a legacy schema
// with no subsections (table-shaped, flat-shaped, or hand-authored) --
// exactly what this rendered before subsections existed.
const SchemaOutline = ({ section, depth }) => {
  const hasSubsections = section.subsections && section.subsections.length > 0;
  // A top-level section's `fields` is the full flattened descendant list
  // (kept for legacy flat-shape consumers -- see templateParser.js);
  // `ownFields` (direct-only, present only alongside subsections) is what
  // this recursive view needs so a nested field isn't listed twice.
  const fields = hasSubsections ? section.ownFields || [] : section.fields || [];
  return (
    <div style={{ marginLeft: depth * 16 }} className="mb-2">
      <b>{section.label}</b>
      <ul className="mb-0">
        {fields.map((field) => (
          <li key={field.key}>{field.group ? `${field.group} · ${field.label}` : field.label}</li>
        ))}
      </ul>
      {hasSubsections && section.subsections.map((sub) => <SchemaOutline key={sub.key} section={sub} depth={depth + 1} />)}
    </div>
  );
};

// "N" as a literal placeholder for the real per-课时 index -- see
// backend/app/services/templateParser.js#splitLessonMarker / dynamicDocGenerator.js#
// renderMarkerLabel, which reconstructs the real arabic/Chinese numeral per
// lesson at generation time; this preview only needs to show the pattern.
const renderLessonMarkerPlaceholder = (marker) => `${marker.before}N${marker.after}`;

// Admin-only: upload a new version of either template, browse version
// history, promote a version to active, delete a superseded/unreferenced
// one, and leave a free-text note on any version. Parsing is automatic (no
// edit-before-publish step -- see template.controller.js#upload), but
// activation never is: a fresh upload always lands inactive, so it always
// shows up here as a draft an admin can 查看字段 to sanity-check before
// deciding to 设为启用 (or just delete it and try a cleaner source file) --
// promotion is a manager's deliberate, separate act, not an automatic
// side effect of uploading.
const TemplateAdmin = () => {
  const [versionsByKey, setVersionsByKey] = useState({});
  const [message, setMessage] = useState("");
  const [uploadingKey, setUploadingKey] = useState("");
  const [expandedVersionId, setExpandedVersionId] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [busyVersionId, setBusyVersionId] = useState(null);
  // Sort state for the "相关课程计划" column, shared across both templates'
  // tables (plan_design / lesson_execution) since only one is ever a
  // meaningful comparison target at a time. null = default order (by
  // version, descending, as returned by the API); clicking the header
  // cycles null -> desc -> asc -> null.
  const [dependentSortDir, setDependentSortDir] = useState(null);
  const toggleDependentSort = () =>
    setDependentSortDir((prev) => (prev === "desc" ? "asc" : prev === "asc" ? null : "desc"));

  const sortByDependentCount = (versions) => {
    if (!dependentSortDir) return versions;
    const sorted = [...versions].sort((a, b) => (a.dependentPlanCount || 0) - (b.dependentPlanCount || 0));
    return dependentSortDir === "asc" ? sorted : sorted.reverse();
  };

  // Popup for the "相关课程计划" count -- clicking it fetches (rather than
  // navigating to /plans, which would lose this page's state) the plans
  // pinned to that one version via plan.controller.js#findAll's
  // ?templateVersionId filter, same either/or match dependentPlanCount
  // itself is computed from. { version, plans, loading, message } | null.
  const [dependentModal, setDependentModal] = useState(null);

  const openDependentModal = async (version) => {
    setDependentModal({ version, plans: [], loading: true, message: "" });
    try {
      const resp = await PlanDataService.getAll({ templateVersionId: version.id, size: 200 });
      setDependentModal({ version, plans: resp.data.rows || [], loading: false, message: "" });
    } catch (err) {
      setDependentModal({
        version,
        plans: [],
        loading: false,
        message: err?.response?.data?.message || "加载相关课程计划失败。",
      });
    }
  };

  const closeDependentModal = () => setDependentModal(null);

  const retrieveAll = useCallback(async () => {
    try {
      const results = await Promise.all(TEMPLATE_KEYS.map((t) => TemplateDataService.list(t.key)));
      const next = {};
      TEMPLATE_KEYS.forEach((t, i) => {
        next[t.key] = results[i].data || [];
      });
      setVersionsByKey(next);
    } catch (e) {
      console.log(e);
      setMessage("加载模板版本失败。");
    }
  }, []);

  useEffect(() => {
    retrieveAll();
  }, [retrieveAll]);

  const handleUpload = async (templateKey, file) => {
    if (!file) return;
    setMessage("");
    setUploadingKey(templateKey);
    try {
      await TemplateDataService.upload(templateKey, file);
      setMessage("模板已上传为新版本（未启用）。请查看字段，确认无误后手动设为启用。");
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "模板上传失败。");
    } finally {
      setUploadingKey("");
    }
  };

  const toggleExpanded = (id) => setExpandedVersionId((prev) => (prev === id ? null : id));

  const handleActivate = async (templateKey, version) => {
    if (!window.confirm(`确定将 v${version.version} 设为启用版本吗？此后新建的乡土课程设计将使用该版本的字段。`)) return;
    setMessage("");
    setBusyVersionId(version.id);
    try {
      await TemplateDataService.activate(templateKey, version.id);
      setMessage(`v${version.version} 已启用。`);
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "启用失败。");
    } finally {
      setBusyVersionId(null);
    }
  };

  const handleMigrate = async (templateKey, version) => {
    if (
      !window.confirm(
        `确定为 v${version.version} 发起迁移吗？使用该版本的 ${version.dependentPlanCount} 个乡土课程设计将提示相关教师迁移到当前启用版本。`
      )
    )
      return;
    setMessage("");
    setBusyVersionId(version.id);
    try {
      const resp = await TemplateDataService.migrate(templateKey, version.id);
      setMessage(resp.data && resp.data.message ? resp.data.message : "已发起迁移。");
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "发起迁移失败。");
    } finally {
      setBusyVersionId(null);
    }
  };

  const handleDelete = async (templateKey, version) => {
    if (!window.confirm(`确定永久删除 v${version.version} 吗？此操作无法撤销。`)) return;
    setMessage("");
    setBusyVersionId(version.id);
    try {
      await TemplateDataService.delete(templateKey, version.id, true);
      setMessage(`v${version.version} 已删除。`);
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    } finally {
      setBusyVersionId(null);
    }
  };

  const handleDownload = async (templateKey, version) => {
    setMessage("");
    try {
      const resp = await TemplateDataService.download(templateKey, version.id);
      const url = window.URL.createObjectURL(
        new Blob([resp.data], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      );
      // Always a real download with the right filename, not "open in a new
      // window" -- a blob: URL carries no Content-Disposition, so navigating
      // a window to it (as this used to do whenever the popup wasn't
      // blocked, which is almost always) made the browser save it under some
      // generic name instead of the original upload's own filename. Same
      // fix already applied correctly in plan-detail.component.js's own
      // handleDownload (see its handlePreview for the actual new-window
      // pattern, used there only for viewing, never for a named download).
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", version.sourceFileName || `${templateKey}-v${version.version}.docx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 60000);
    } catch (err) {
      console.log(err);
      setMessage("模板下载失败。");
    }
  };

  // Opens a blank window synchronously, before the first await, so the
  // browser attributes it to this click and doesn't treat it as a
  // popup-blocked async open -- then fills it in once the doc's converted.
  // Same pattern as plan-detail.component.js's DesignDocPanel#handlePreview.
  const handlePreview = async (templateKey, version) => {
    setMessage("");
    const label = version.sourceFileName || `${templateKey}-v${version.version}.docx`;
    const win = window.open("", "_blank");
    if (win) win.document.write(`<title>预览：${label}</title><body>预览加载中...</body>`);
    try {
      const resp = await TemplateDataService.download(templateKey, version.id);
      const result = await mammoth.convertToHtml({ arrayBuffer: resp.data });
      if (win) {
        win.document.open();
        win.document.write(
          `<!doctype html><html><head><meta charset="utf-8"><title>预览：${label}</title>` +
            `<style>body{max-width:800px;margin:24px auto;padding:0 16px;font-family:sans-serif;line-height:1.6;}</style>` +
            `</head><body>${result.value || "<p>文档内容为空。</p>"}</body></html>`
        );
        win.document.close();
      }
    } catch (err) {
      console.log(err);
      setMessage("模板预览失败。");
      if (win) win.close();
    }
  };

  const startEditNote = (version) => {
    setEditingNoteId(version.id);
    setNoteDraft(version.notes || "");
  };

  const cancelEditNote = () => {
    setEditingNoteId(null);
    setNoteDraft("");
  };

  const saveNote = async (templateKey, version) => {
    setMessage("");
    setBusyVersionId(version.id);
    try {
      await TemplateDataService.updateNote(templateKey, version.id, noteDraft);
      setEditingNoteId(null);
      setNoteDraft("");
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存备注失败。");
    } finally {
      setBusyVersionId(null);
    }
  };

  return (
    <div className="container pl-page">
      <h4 className="pl-title mb-3">模板管理</h4>
      {message && <div className="alert alert-info py-2">{message}</div>}

      {TEMPLATE_KEYS.map((t) => {
        const versions = sortByDependentCount(versionsByKey[t.key] || []);
        return (
          <div className="pl-card mb-4" key={t.key}>
            <div className="d-flex justify-content-between align-items-center mb-2">
              <h6 className="mb-0">{t.label}</h6>
              <label className="btn btn-outline-primary btn-sm mb-0">
                {uploadingKey === t.key ? "上传中..." : "上传新版本"}
                <input
                  type="file"
                  accept=".docx"
                  className="d-none"
                  disabled={uploadingKey === t.key}
                  onChange={(e) => {
                    handleUpload(t.key, e.target.files[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>

            {versions.length === 0 ? (
              <div className="pl-empty">暂无版本。</div>
            ) : (
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>状态</th>
                    <th>备注</th>
                    <th>来源文件</th>
                    <th>上传人</th>
                    <th>创建时间</th>
                    <th>字段</th>
                    <th
                      role="button"
                      onClick={toggleDependentSort}
                      style={{ cursor: "pointer", userSelect: "none" }}
                      title="点击排序"
                    >
                      相关课程计划
                      {dependentSortDir === "desc" && " ▼"}
                      {dependentSortDir === "asc" && " ▲"}
                    </th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <React.Fragment key={v.id}>
                      <tr>
                        <td>v{v.version}</td>
                        <td>{v.isActive ? <span className="pl-tag">启用中</span> : "-"}</td>
                        <td style={{ minWidth: 180 }}>
                          {editingNoteId === v.id ? (
                            <div>
                              <textarea
                                className="form-control form-control-sm mb-1"
                                rows="2"
                                value={noteDraft}
                                onChange={(e) => setNoteDraft(e.target.value)}
                              />
                              <button
                                className="btn btn-primary btn-sm mr-1"
                                type="button"
                                disabled={busyVersionId === v.id}
                                onClick={() => saveNote(t.key, v)}
                              >
                                保存
                              </button>
                              <button className="btn btn-outline-secondary btn-sm" type="button" onClick={cancelEditNote}>
                                取消
                              </button>
                            </div>
                          ) : (
                            <div>
                              {v.notes ? <div className="mb-1" style={{ whiteSpace: "pre-wrap" }}>{v.notes}</div> : null}
                              <button className="btn btn-link p-0" type="button" onClick={() => startEditNote(v)}>
                                {v.notes ? "编辑备注" : "添加备注"}
                              </button>
                            </div>
                          )}
                        </td>
                        <td>{v.sourceFileName || "（初始模板）"}</td>
                        <td>{v.Uploader ? v.Uploader.chineseName || v.Uploader.username : "-"}</td>
                        <td>{v.createdAt ? new Date(v.createdAt).toLocaleString() : "-"}</td>
                        <td>
                          <button className="btn btn-link p-0" type="button" onClick={() => toggleExpanded(v.id)}>
                            {expandedVersionId === v.id ? "收起" : "查看字段"}
                          </button>
                        </td>
                        <td>
                          {v.dependentPlanCount > 0 ? (
                            <button className="btn btn-link p-0" type="button" onClick={() => openDependentModal(v)}>
                              {v.dependentPlanCount}
                            </button>
                          ) : (
                            v.dependentPlanCount || 0
                          )}
                        </td>
                        <td className="text-nowrap">
                          <button
                            className="btn btn-outline-primary btn-sm mr-1"
                            type="button"
                            onClick={() => handleDownload(t.key, v)}
                          >
                            下载
                          </button>
                          <button
                            className="btn btn-outline-primary btn-sm mr-1"
                            type="button"
                            onClick={() => handlePreview(t.key, v)}
                          >
                            预览
                          </button>
                          {/* Migration (plan_design only -- see
                              templateMigration.js) only makes sense for a
                              non-active version that still has dependent
                              plans; it self-hides once they've all migrated
                              away, since dependentPlanCount then drops to 0. */}
                          {t.key === "plan_design" && !v.isActive && v.dependentPlanCount > 0 && (
                            <button
                              className="btn btn-outline-warning btn-sm mr-1"
                              type="button"
                              disabled={busyVersionId === v.id}
                              onClick={() => handleMigrate(t.key, v)}
                            >
                              发起迁移
                            </button>
                          )}
                          {!v.isActive && (
                            <button
                              className="btn btn-outline-primary btn-sm mr-1"
                              type="button"
                              disabled={busyVersionId === v.id}
                              onClick={() => handleActivate(t.key, v)}
                            >
                              设为启用
                            </button>
                          )}
                          {!v.isActive && (
                            <button
                              className="btn btn-outline-danger btn-sm"
                              type="button"
                              disabled={busyVersionId === v.id}
                              onClick={() => handleDelete(t.key, v)}
                            >
                              删除
                            </button>
                          )}
                        </td>
                      </tr>
                      {expandedVersionId === v.id && (
                        <tr>
                          <td colSpan={9}>
                            {(v.schemaJson?.sections || []).map((section) => (
                              <SchemaOutline key={section.key} section={section} depth={0} />
                            ))}
                            {v.schemaJson?.lessonSchema && (
                              // Not part of `sections` -- see templateParser.js#extractLessonSchema's
                              // comment: this is a reusable per-课时 field template applied once per
                              // lesson index (plan.planFormData.lessons), not a single-instance
                              // section like WHY/WHAT/HOW, so it's shown here only for admin
                              // visibility into what was parsed, separate from the field-schema list.
                              <SchemaOutline
                                key="lessonSchema"
                                depth={0}
                                section={{
                                  label: `${v.schemaJson.lessonBreakdownLabel || "分课时设计"} · 每课时重复（如：${renderLessonMarkerPlaceholder(
                                    v.schemaJson.lessonSchema.marker
                                  )}）`,
                                  fields: v.schemaJson.lessonSchema.fields,
                                  ownFields: v.schemaJson.lessonSchema.fields,
                                  subsections: v.schemaJson.lessonSchema.subsections,
                                }}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}

      {dependentModal && (
        <div className="pl-modal-backdrop" onClick={closeDependentModal}>
          <div className="pl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-center mb-2">
              <h6 className="mb-0">相关课程计划 · v{dependentModal.version.version}</h6>
              <button className="btn btn-link p-0" type="button" onClick={closeDependentModal}>
                关闭
              </button>
            </div>
            {dependentModal.loading ? (
              <div className="pl-empty">加载中...</div>
            ) : dependentModal.message ? (
              <div className="alert alert-danger py-2">{dependentModal.message}</div>
            ) : dependentModal.plans.length === 0 ? (
              <div className="pl-empty">暂无相关课程计划。</div>
            ) : (
              <>
                <div className="pl-modal-list">
                  {dependentModal.plans.map((p) => (
                    <Link
                      key={p.id}
                      to={`/plans/${p.id}`}
                      className="pl-modal-row d-block"
                      onClick={closeDependentModal}
                    >
                      <div>{p.title || "未命名课程设计"}</div>
                      <div className="text-muted small">
                        {p.Teacher ? p.Teacher.chineseName || p.Teacher.username : "-"}
                        {p.year ? ` · ${p.year}` : ""}
                        {p.season ? ` ${p.season}` : ""}
                      </div>
                    </Link>
                  ))}
                </div>
                <div className="mt-2 text-right">
                  <Link to={`/plans?templateVersionId=${dependentModal.version.id}`} onClick={closeDependentModal}>
                    在完整列表中查看 →
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default TemplateAdmin;
