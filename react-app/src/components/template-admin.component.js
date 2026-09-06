import React, { useCallback, useEffect, useState } from "react";
import TemplateDataService from "../services/template.service";
import "../curriculum.css";

const TEMPLATE_KEYS = [
  { key: "plan_design", label: "课程设计方案模板（WHY/WHAT/HOW）" },
  { key: "lesson_execution", label: "课时实施记录模板" },
];

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
    // Opened synchronously, before the await, so popup blockers see it as a
    // direct result of the click; the blob URL is dropped in once the
    // (auth-header-gated) request resolves.
    const newWindow = window.open("", "_blank");
    try {
      const resp = await TemplateDataService.download(templateKey, version.id);
      const url = window.URL.createObjectURL(
        new Blob([resp.data], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      );
      if (newWindow) {
        newWindow.location = url;
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.setAttribute("download", version.sourceFileName || `${templateKey}-v${version.version}.docx`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setTimeout(() => window.URL.revokeObjectURL(url), 60000);
    } catch (err) {
      console.log(err);
      setMessage("模板下载失败。");
      if (newWindow) newWindow.close();
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
        const versions = versionsByKey[t.key] || [];
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
                        <td className="text-nowrap">
                          <button
                            className="btn btn-outline-primary btn-sm mr-1"
                            type="button"
                            onClick={() => handleDownload(t.key, v)}
                          >
                            下载
                          </button>
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
                          <td colSpan={8}>
                            {(v.schemaJson?.sections || []).map((section) => (
                              <div key={section.key} className="mb-2">
                                <b>{section.label}</b>
                                <ul className="mb-0">
                                  {(section.fields || []).map((field) => (
                                    <li key={field.key}>
                                      {field.group ? `${field.group} · ${field.label}` : field.label}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
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
    </div>
  );
};

export default TemplateAdmin;
