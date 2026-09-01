import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import mammoth from "mammoth/mammoth.browser";
import PlanDataService from "../services/plan.service";
import ArtifactDataService from "../services/artifact.service";
import AuthService from "../services/auth.service";
import Pagination from "@material-ui/lab/Pagination";
import { PLAN_THEMES, PLAN_GRADES, PLAN_MODES } from "../constants/plan-options";
import "../curriculum.css";

const STATUS_LABELS = { draft: "草稿", submitted: "已提交", reviewed: "已点评" };

const emptyForm = {
  title: "",
  theme: "",
  grade: "",
  year: "",
  plannedLessonCount: "",
  planMode: "online",
};

const UPLOAD_FIELD_LABELS = { title: "标题", grade: "年级", plannedLessonCount: "预计课时" };

// Best-effort field extraction against curriculum_template/乡土课程设计方案模版.docx's
// labeled header (课程名称/任教年级/预计课时 -- 乡土主题 and 年份 aren't labeled in
// the template at all, so those are never guessed, only ever filled in by hand).
const extractPlanFieldsFromText = (text) => {
  const result = {};

  const titleMatch = text.match(/课程名称[：:]\s*([^\n]+)/);
  if (titleMatch && titleMatch[1].trim()) result.title = titleMatch[1].trim();

  const gradeMatch = text.match(/任教年级[：:]\s*([^\n]+)/);
  if (gradeMatch) {
    const found = PLAN_GRADES.find((g) => gradeMatch[1].includes(g));
    if (found) result.grade = found;
  }

  const lessonMatch = text.match(/预计课时[：:]\s*(\d+)/);
  if (lessonMatch) result.plannedLessonCount = lessonMatch[1];

  return result;
};

const currentUserId = () => {
  const user = AuthService.getCurrentUser();
  return user ? user.id : null;
};

// Migrated from shinshin's cases-list.component.js: functional component, server-side
// pagination via @material-ui/lab Pagination, card-grid layout, slide-in drawer
// create/edit form, and the `stylishPublic` unauthenticated-view styling (here also
// forced on for the public "优秀案例展示" gallery via props.excellentOnly).
//
// One component/route serves every /plans context (a teacher's own plans, an admin's
// full list, an expert's 待点评 queue, the public gallery) rather than separate pages --
// "mine vs all" is a live toggle (admin only, who's the sole role with legitimate
// access to both) instead of a route distinction, so there's exactly one layout to
// maintain instead of two.
const PlansList = (props) => {
  const location = props.location || window.location;
  const queryParams = useMemo(() => new URLSearchParams(location.search || ""), [location.search]);
  const mineOnly = queryParams.get("mine") === "true";
  const statusFilter = queryParams.get("status") || "";
  const excellentOnly = !!props.excellentOnly;

  const [plans, setPlans] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalPages, setTotalPages] = useState(0);
  const [totalItems, setTotalItems] = useState(0);
  const [searchTheme, setSearchTheme] = useState("");
  const [searchGrade, setSearchGrade] = useState("");
  const [searchYear, setSearchYear] = useState("");
  // planMode='upload' drag-drop: the picked file both seeds form fields (best-
  // effort, see extractPlanFieldsFromText) and gets attached as the new plan's
  // 课程设计文件 artifact right after creation (see onSubmit).
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const uploadFileInputRef = useRef(null);

  // Only teachers author a new plan -- managers/experts manage existing
  // cases (suspend/delete/promote/review) but don't create their own, matching
  // plan.routes.js's isTeacher-only gate on POST /api/plans.
  const canCreate = !excellentOnly && AuthService.isTeacher();
  const stylishPublic = excellentOnly || !AuthService.isLogin();
  // mine=true only ever comes from a teacher's own landing link -- a manager
  // is only ever interested in all plans, so there's no "只看我的" toggle to
  // offer them (removed; previously shown to admin only, but managing means
  // seeing everything, not filtering to a personal subset that's usually empty).
  const effectiveMineOnly = mineOnly;

  const isOwnerOf = (item) => AuthService.isTeacher() && String(item.teacherId) === String(currentUserId());
  // Editing a plan's content is owner-only, no admin bypass -- managers can
  // suspend/delete/promote/leave notes (see below), but not edit case content.
  const canEditItem = (item) => !item.suspended && isOwnerOf(item);
  const canDeleteItem = (item) => AuthService.isAdmin() || isOwnerOf(item);

  const retrieveAll = useCallback(async () => {
    try {
      // No pagination UI in the mine=true view (a teacher's own plan count is
      // small by nature) -- fetch a generous single page instead of paging.
      const resp = await PlanDataService.getAll({
        page: effectiveMineOnly ? 0 : page - 1,
        size: effectiveMineOnly ? 200 : pageSize,
        keyword: keyword || undefined,
        year: searchYear || undefined,
        theme: searchTheme || undefined,
        grade: searchGrade || undefined,
        mine: effectiveMineOnly ? true : undefined,
        status: statusFilter || undefined,
        isExcellentCase: excellentOnly ? true : undefined,
      });
      setPlans(resp.data.rows || []);
      setTotalPages(resp.data.totalPages || 0);
      setTotalItems(resp.data.totalItems || 0);
    } catch (e) {
      console.log(e);
      setMessage("加载课程设计数据失败。");
    }
  }, [page, pageSize, keyword, searchYear, searchTheme, searchGrade, effectiveMineOnly, statusFilter, excellentOnly]);

  useEffect(() => {
    retrieveAll();
  }, [retrieveAll]);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    try {
      const payload = {
        title: form.title,
        theme: form.theme || null,
        grade: form.grade || null,
        year: Number(form.year),
        plannedLessonCount: form.plannedLessonCount ? Number(form.plannedLessonCount) : null,
        planMode: form.planMode,
      };
      if (editingId) {
        await PlanDataService.update(editingId, payload);
        setMessage("课程设计更新成功。");
      } else {
        const created = await PlanDataService.create(payload);
        setMessage("课程设计创建成功。");
        if (uploadFile && created?.data?.id) {
          try {
            const fd = new FormData();
            fd.append("category", "课程设计文件");
            fd.append("description", "");
            fd.append("file", uploadFile);
            await ArtifactDataService.create(created.data.id, fd);
          } catch (uploadErr) {
            setMessage("课程设计创建成功，但文件上传失败，请稍后在详情页手动上传。");
          }
        }
      }
      setEditingId(null);
      setForm(emptyForm);
      setUploadFile(null);
      setUploadStatus("");
      setIsEditorOpen(false);
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存失败。");
    }
  };

  const handleUploadFile = async (file) => {
    if (!file) return;
    setUploadFile(file);
    setUploadStatus("正在解析文件...");
    const ext = (file.name || "").toLowerCase().split(".").pop();
    if (ext !== "docx") {
      setUploadStatus("已选择文件；仅支持自动识别 .docx 的内容，其余字段请手动填写。");
      return;
    }
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const extracted = extractPlanFieldsFromText(result.value || "");
      const matchedLabels = Object.keys(extracted).map((k) => UPLOAD_FIELD_LABELS[k]);
      setForm((prev) => ({ ...prev, ...extracted }));
      setUploadStatus(
        matchedLabels.length > 0 ? `已从文件中识别：${matchedLabels.join("、")}，请核对后提交。` : "未能从文件中自动识别课程信息，请手动填写。"
      );
    } catch (err) {
      console.log(err);
      setUploadStatus("文件解析失败，请手动填写课程信息。");
    }
  };

  const openCreateEditor = () => {
    setEditingId(null);
    setForm({ ...emptyForm, year: String(new Date().getFullYear()), theme: searchTheme });
    setUploadFile(null);
    setUploadStatus("");
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    setEditingId(null);
    setForm(emptyForm);
    setUploadFile(null);
    setUploadStatus("");
    setIsEditorOpen(false);
  };

  const onEdit = (item) => {
    setEditingId(item.id);
    setForm({
      title: item.title || "",
      theme: item.theme || "",
      grade: item.grade || "",
      year: item.year ? String(item.year) : "",
      plannedLessonCount: item.plannedLessonCount ? String(item.plannedLessonCount) : "",
      planMode: item.planMode || "online",
    });
    setUploadFile(null);
    setUploadStatus("");
    setIsEditorOpen(true);
  };

  const onDelete = async (item) => {
    const ok = window.confirm("此操作将永久删除该课程设计及其所有附件与点评，且无法撤销。确定继续吗？");
    if (!ok) return;
    try {
      await PlanDataService.delete(item.id, true);
      setMessage("课程设计删除成功。");
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    }
  };

  const toggleExcellent = async (item) => {
    try {
      await PlanDataService.update(item.id, { isExcellentCase: !item.isExcellentCase });
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };

  const toggleSuspend = async (item) => {
    if (!item.suspended) {
      const ok = window.confirm(`确定停用「${item.title}」吗？停用后该课程设计将从公开列表中隐藏，仅本人与管理员可见。`);
      if (!ok) return;
    }
    try {
      if (item.suspended) {
        await PlanDataService.unsuspend(item.id);
      } else {
        await PlanDataService.suspend(item.id);
      }
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };

  const onSearch = () => {
    setPage(1);
    retrieveAll();
  };

  const heading = excellentOnly
    ? "优秀案例展示"
    : effectiveMineOnly
    ? "我的乡土课程"
    : statusFilter === "submitted"
    ? "待点评案例"
    : "乡土课程设计";

  return (
    <div className={`container ${stylishPublic ? "pl-page" : ""}`}>
      {stylishPublic ? (
        <div className="pl-hero">
          <h4 className="pl-title">{heading}</h4>
          <p className="pl-subtitle">按乡土主题与年级筛选浏览乡土课程设计。</p>
          <div className="pl-kpis">
            <span className="pl-kpi">总数：{totalItems}</span>
            <span className="pl-kpi">
              当前页：{page}/{totalPages || 1}
            </span>
          </div>
        </div>
      ) : (
        <h4>
          {heading}（总数：{totalItems}）
        </h4>
      )}

      {/* A teacher's own plans list is small by nature -- search/filter/pagination
          are noise there, not a tool; every other view (admin's 全部, the public
          gallery, the expert queue) keeps them since those lists can be long. */}
      {!effectiveMineOnly && (
        <>
      <div className={stylishPublic ? "pl-card" : "mb-3"}>
        <div className="input-group">
          <input
            className="form-control"
            placeholder="按标题搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="input-group-append">
            <button className="btn btn-outline-secondary" type="button" onClick={onSearch}>
              搜索
            </button>
          </div>
        </div>
      </div>

      <div className={stylishPublic ? "pl-card" : "mb-3"}>
        <div className="form-row">
          <div className="form-group col-md-4">
            <label>年份筛选</label>
            <input
              className="form-control"
              type="number"
              min="1900"
              max="2100"
              placeholder="例如 2026"
              value={searchYear}
              onChange={(e) => setSearchYear(e.target.value)}
            />
          </div>
          <div className="form-group col-md-4">
            <label>年级筛选</label>
            <select className="form-control" value={searchGrade} onChange={(e) => setSearchGrade(e.target.value)}>
              <option value="">全部年级</option>
              {PLAN_GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group col-md-4">
            <label>主题筛选</label>
            <select
              className="form-control"
              value={searchTheme}
              onChange={(e) => {
                setSearchTheme(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部主题</option>
              {PLAN_THEMES.map((theme) => (
                <option key={theme} value={theme}>
                  {theme}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
        </>
      )}

      {canCreate && (
        <div className={stylishPublic ? "pl-card" : "mb-3"}>
          <button className="btn btn-primary" type="button" onClick={openCreateEditor}>
            新增乡土课程设计
          </button>
        </div>
      )}

      {message && <div className="alert alert-info py-2">{message}</div>}

      {plans.length === 0 ? (
        <div className="pl-empty">暂无数据</div>
      ) : (
        <div className="pl-plan-grid">
          {plans.map((item) => (
            <div className="pl-plan-card" key={item.id}>
              {item.isExcellentCase && <span className="pl-plan-card-excellent">优秀案例</span>}
              {item.suspended && <span className="pl-plan-card-suspended">已停用</span>}
              <div className="pl-plan-card-head">
                <div className="pl-plan-card-badge">
                  <i className="fas fa-seedling"></i>
                </div>
                <div>
                  <h6 className="pl-plan-card-title">{item.title}</h6>
                  <div className="pl-plan-card-year">{item.year || "-"} 年</div>
                </div>
              </div>

              <div className="pl-plan-card-tags">
                {item.theme && <span className="pl-tag">{item.theme}</span>}
                <span className={`pl-plan-card-status status-${item.status || "draft"}`}>
                  {STATUS_LABELS[item.status] || STATUS_LABELS.draft}
                </span>
              </div>

              <div className="pl-plan-card-meta">
                <span>
                  <i className="fas fa-graduation-cap"></i> {item.grade || "年级未定"}
                </span>
                <span>
                  <i className="fas fa-clock"></i> {item.plannedLessonCount ? `${item.plannedLessonCount} 课时` : "课时未定"}
                </span>
              </div>

              <div className="pl-plan-card-footer">
                <Link className="btn btn-link p-0" to={`/plans/${item.id}`}>
                  查看详情
                </Link>
                <div>
                  {AuthService.isAdmin() && (
                    <button className="btn btn-link p-0 mr-2" onClick={() => toggleExcellent(item)}>
                      {item.isExcellentCase ? "取消优秀案例" : "设为优秀案例"}
                    </button>
                  )}
                  {AuthService.isAdmin() && (
                    <button className="btn btn-link p-0 mr-2" onClick={() => toggleSuspend(item)}>
                      {item.suspended ? "启用" : "停用"}
                    </button>
                  )}
                  {canEditItem(item) && (
                    <button className="btn btn-link p-0 mr-2" onClick={() => onEdit(item)}>
                      编辑
                    </button>
                  )}
                  {canDeleteItem(item) && (
                    <button className="btn btn-link p-0 text-danger" onClick={() => onDelete(item)}>
                      删除
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!effectiveMineOnly && (
        <>
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
        </>
      )}

      {canCreate && isEditorOpen && (
        <div className="pl-drawer-layer">
          <button className="pl-drawer-mask" type="button" onClick={closeEditor} aria-label="close editor" />
          <div className="pl-drawer-panel">
            <div className="pl-drawer-head">
              <h5 className="mb-0">{editingId ? "编辑乡土课程设计" : "新增乡土课程设计"}</h5>
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
                <label>年份</label>
                <input
                  className="form-control"
                  name="year"
                  type="number"
                  min="1900"
                  max="2100"
                  value={form.year}
                  onChange={onChange}
                  required
                />
              </div>
              <div className="form-group">
                <label>乡土主题</label>
                <select className="form-control" name="theme" value={form.theme} onChange={onChange}>
                  <option value="">请选择主题</option>
                  {PLAN_THEMES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>年级</label>
                <select className="form-control" name="grade" value={form.grade} onChange={onChange}>
                  <option value="">请选择年级</option>
                  {PLAN_GRADES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>预计课时</label>
                <input
                  className="form-control"
                  name="plannedLessonCount"
                  type="number"
                  min="1"
                  max="60"
                  value={form.plannedLessonCount}
                  onChange={onChange}
                />
              </div>
              <div className="form-group">
                <label>填写方式</label>
                <select className="form-control" name="planMode" value={form.planMode} onChange={onChange}>
                  {PLAN_MODES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              {form.planMode === "upload" && !editingId && (
                <div className="form-group">
                  <label>上传乡土课程设计文件（可选，自动识别课程信息）</label>
                  <div
                    className={`pl-file-drop-zone ${uploadDragActive ? "is-dragover" : ""}`}
                    onClick={() => uploadFileInputRef.current && uploadFileInputRef.current.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setUploadDragActive(true);
                    }}
                    onDragLeave={() => setUploadDragActive(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setUploadDragActive(false);
                      handleUploadFile(e.dataTransfer?.files?.[0]);
                    }}
                  >
                    {uploadFile ? uploadFile.name : "拖拽课程设计文件到这里，或点击选择文件"}
                  </div>
                  <input
                    ref={uploadFileInputRef}
                    type="file"
                    className="d-none"
                    onChange={(e) => handleUploadFile(e.target.files[0])}
                  />
                  {uploadStatus && <small className="form-text text-muted">{uploadStatus}</small>}
                </div>
              )}
              <div className="d-flex">
                <button className="btn btn-primary mr-2" type="submit">
                  {editingId ? "更新" : "新增"}
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

export default PlansList;
