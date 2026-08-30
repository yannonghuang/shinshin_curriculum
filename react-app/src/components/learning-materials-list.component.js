import React, { useCallback, useEffect, useState } from "react";
import LearningMaterialDataService from "../services/learning-material.service";
import AuthService from "../services/auth.service";
import Pagination from "@material-ui/lab/Pagination";
import { PLAN_THEMES, PLAN_GRADES } from "../constants/plan-options";
import "../curriculum.css";

const emptyForm = {
  title: "",
  description: "",
  materialType: "file",
  file: null,
  externalUrl: "",
  theme: "",
  grade: "",
};

// Migrated from shinshin's materials-list.component.js (paginated file-list CRUD UI),
// extended with a file-vs-link toggle: admin can either upload a file (multipart FormData,
// following artifact.service.js's onUploadProgress pattern) or register an external link
// (plain JSON POST with externalUrl, e.g. a training video URL). Teachers/experts/public
// browse the shared library filtered by theme + grade.
const LearningMaterialsList = () => {
  const [materials, setMaterials] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [uploadProgress, setUploadProgress] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalPages, setTotalPages] = useState(0);
  const [totalItems, setTotalItems] = useState(0);
  const [searchTheme, setSearchTheme] = useState("");
  const [searchGrade, setSearchGrade] = useState("");
  const [keyword, setKeyword] = useState("");

  const canEdit = AuthService.isAdmin();

  const retrieveAll = useCallback(async () => {
    try {
      const resp = await LearningMaterialDataService.getAll({
        page: page - 1,
        size: pageSize,
        keyword: keyword || undefined,
        theme: searchTheme || undefined,
        grade: searchGrade || undefined,
      });
      setMaterials(resp.data.rows || []);
      setTotalPages(resp.data.totalPages || 0);
      setTotalItems(resp.data.totalItems || 0);
    } catch (e) {
      console.log(e);
      setMessage("加载学习材料失败。");
    }
  }, [page, pageSize, keyword, searchTheme, searchGrade]);

  useEffect(() => {
    retrieveAll();
  }, [retrieveAll]);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const onFileChange = (e) => {
    const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
    setForm((prev) => ({ ...prev, file }));
  };

  const openCreateEditor = () => {
    setEditingId(null);
    setForm(emptyForm);
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    setEditingId(null);
    setForm(emptyForm);
    setIsEditorOpen(false);
  };

  const onEdit = (item) => {
    setEditingId(item.id);
    setForm({
      title: item.title || "",
      description: item.description || "",
      materialType: item.materialType || "file",
      file: null,
      externalUrl: item.externalUrl || "",
      theme: item.theme || "",
      grade: item.grade || "",
    });
    setIsEditorOpen(true);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setMessage("");

    if (form.materialType === "file") {
      if (!editingId && !form.file) {
        setMessage("请先选择文件。");
        return;
      }
      const formData = new FormData();
      formData.append("title", form.title);
      formData.append("description", form.description || "");
      formData.append("materialType", "file");
      formData.append("theme", form.theme || "");
      formData.append("grade", form.grade || "");
      if (form.file) formData.append("file", form.file);

      try {
        setIsUploading(true);
        setUploadProgress(0);
        const onProgress = (event) => {
          if (!event || !event.total) return;
          setUploadProgress(Math.min(100, Math.round((event.loaded * 100) / event.total)));
        };
        if (editingId) {
          await LearningMaterialDataService.update(editingId, formData, onProgress);
          setMessage("学习材料更新成功。");
        } else {
          await LearningMaterialDataService.create(formData, onProgress);
          setMessage("学习材料创建成功。");
        }
        closeEditor();
        retrieveAll();
      } catch (err) {
        setMessage(err?.response?.data?.message || "保存失败。");
      } finally {
        setIsUploading(false);
        setTimeout(() => setUploadProgress(null), 600);
      }
    } else {
      const payload = {
        title: form.title,
        description: form.description || "",
        materialType: "link",
        externalUrl: form.externalUrl,
        theme: form.theme || "",
        grade: form.grade || "",
      };
      try {
        if (editingId) {
          await LearningMaterialDataService.update(editingId, payload);
          setMessage("学习材料更新成功。");
        } else {
          await LearningMaterialDataService.create(payload);
          setMessage("学习材料创建成功。");
        }
        closeEditor();
        retrieveAll();
      } catch (err) {
        setMessage(err?.response?.data?.message || "保存失败。");
      }
    }
  };

  const onDelete = async (item) => {
    if (!window.confirm("确定要删除该学习材料吗？")) return;
    try {
      await LearningMaterialDataService.delete(item.id, true);
      setMessage("学习材料删除成功。");
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    }
  };

  const downloadOrPreview = async (item, previewOnly) => {
    try {
      const resp = await LearningMaterialDataService.download(item.id);
      const url = window.URL.createObjectURL(new Blob([resp.data], { type: item.attachmentMime || "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      if (previewOnly) {
        link.target = "_blank";
      } else {
        link.setAttribute("download", item.attachmentName || `material-${item.id}`);
      }
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      console.log(e);
      setMessage("下载失败。");
    }
  };

  return (
    <div className="container pl-page">
      <div className="pl-hero">
        <h4 className="pl-title">共享学习材料库（总数：{totalItems}）</h4>
        <p className="pl-subtitle">讲座材料、培训视频等，可按乡土主题与年级筛选。</p>
      </div>

      <div className="pl-card">
        <div className="form-row">
          <div className="form-group col-md-4">
            <label>标题搜索</label>
            <input className="form-control" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
          <div className="form-group col-md-4">
            <label>乡土主题</label>
            <select className="form-control" value={searchTheme} onChange={(e) => setSearchTheme(e.target.value)}>
              <option value="">全部主题</option>
              {PLAN_THEMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group col-md-4">
            <label>年级</label>
            <select className="form-control" value={searchGrade} onChange={(e) => setSearchGrade(e.target.value)}>
              <option value="">全部年级</option>
              {PLAN_GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => { setPage(1); retrieveAll(); }}>
          搜索
        </button>
      </div>

      {canEdit && (
        <div className="pl-card">
          <button className="btn btn-primary" type="button" onClick={openCreateEditor}>
            新增学习材料
          </button>
        </div>
      )}

      {message && <div className="alert alert-info py-2">{message}</div>}

      <div className="pl-table-wrap">
        <table className="table table-sm table-bordered">
          <thead>
            <tr>
              <th>标题</th>
              <th>类型</th>
              <th>主题</th>
              <th>年级</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {materials.map((item) => (
              <tr key={item.id}>
                <td>{item.title}</td>
                <td>
                  <span className="pl-tag">{item.materialType === "link" ? "链接" : "文件"}</span>
                </td>
                <td>{item.theme || "-"}</td>
                <td>{item.grade || "-"}</td>
                <td>{item.createdAt ? new Date(item.createdAt).toLocaleDateString("zh-cn") : "-"}</td>
                <td>
                  {item.materialType === "link" ? (
                    <a href={item.externalUrl} target="_blank" rel="noopener noreferrer" className="mr-2">
                      打开链接
                    </a>
                  ) : (
                    <>
                      <button className="btn btn-link p-0 mr-2" onClick={() => downloadOrPreview(item, true)}>
                        预览
                      </button>
                      <button className="btn btn-link p-0 mr-2" onClick={() => downloadOrPreview(item, false)}>
                        下载
                      </button>
                    </>
                  )}
                  {canEdit && (
                    <>
                      <button className="btn btn-link p-0 mr-2" onClick={() => onEdit(item)}>
                        编辑
                      </button>
                      <button className="btn btn-link p-0 text-danger" onClick={() => onDelete(item)}>
                        删除
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {materials.length === 0 && (
              <tr>
                <td colSpan="6" className="pl-empty">
                  暂无学习材料
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 d-flex align-items-center">
        <label className="mr-2 mb-0">每页条数</label>
        <select
          className="form-control form-control-sm"
          style={{ width: "100px" }}
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
        >
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
        </select>
      </div>
      <Pagination
        className="my-3"
        count={totalPages || 1}
        page={page}
        siblingCount={1}
        boundaryCount={1}
        onChange={(event, value) => setPage(value)}
      />

      {canEdit && isEditorOpen && (
        <div className="pl-drawer-layer">
          <button className="pl-drawer-mask" type="button" onClick={closeEditor} aria-label="close editor" />
          <div className="pl-drawer-panel">
            <div className="pl-drawer-head">
              <h5 className="mb-0">{editingId ? "编辑学习材料" : "新增学习材料"}</h5>
              <button className="btn btn-link p-0" type="button" onClick={closeEditor}>
                关闭
              </button>
            </div>
            <form onSubmit={onSubmit}>
              <div className="form-group">
                <label>标题</label>
                <input className="form-control" name="title" value={form.title} onChange={onChange} required />
              </div>
              <div className="form-group">
                <label>描述</label>
                <textarea className="form-control" name="description" value={form.description} onChange={onChange} rows="3" />
              </div>
              <div className="form-group">
                <label>类型</label>
                <div className="pl-material-toggle">
                  <button
                    type="button"
                    className={`btn btn-outline-primary btn-sm ${form.materialType === "file" ? "is-active" : ""}`}
                    onClick={() => setForm((prev) => ({ ...prev, materialType: "file" }))}
                  >
                    文件
                  </button>
                  <button
                    type="button"
                    className={`btn btn-outline-primary btn-sm ${form.materialType === "link" ? "is-active" : ""}`}
                    onClick={() => setForm((prev) => ({ ...prev, materialType: "link" }))}
                  >
                    外部链接
                  </button>
                </div>
              </div>
              {form.materialType === "file" ? (
                <div className="form-group">
                  <label>文件</label>
                  <input className="form-control" type="file" onChange={onFileChange} disabled={isUploading} />
                  {uploadProgress !== null && (
                    <div className="pl-progress-wrap">
                      <div className="progress">
                        <div
                          className="progress-bar progress-bar-striped progress-bar-animated"
                          role="progressbar"
                          style={{ width: `${uploadProgress}%` }}
                        >
                          {uploadProgress}%
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="form-group">
                  <label>外部链接（视频链接等）</label>
                  <input
                    className="form-control"
                    name="externalUrl"
                    value={form.externalUrl}
                    onChange={onChange}
                    placeholder="https://..."
                    required
                  />
                </div>
              )}
              <div className="form-group">
                <label>乡土主题</label>
                <select className="form-control" name="theme" value={form.theme} onChange={onChange}>
                  <option value="">不限</option>
                  {PLAN_THEMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>年级</label>
                <select className="form-control" name="grade" value={form.grade} onChange={onChange}>
                  <option value="">不限</option>
                  {PLAN_GRADES.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
              <div className="d-flex">
                <button className="btn btn-primary mr-2" type="submit" disabled={isUploading}>
                  {isUploading ? "上传中..." : editingId ? "更新" : "新增"}
                </button>
                <button className="btn btn-secondary" type="button" onClick={closeEditor}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default LearningMaterialsList;
