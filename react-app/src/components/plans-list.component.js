import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mammoth from "mammoth/mammoth.browser";
import PlanDataService from "../services/plan.service";
import TemplateDataService from "../services/template.service";
import AuthService from "../services/auth.service";
import Pagination from "@material-ui/lab/Pagination";
import PlanCard from "./plan-card.component";
import PlansHierarchy from "./plans-hierarchy.component";
import { PLAN_THEMES, PLAN_GRADES, PLAN_SEASONS, currentSeason } from "../constants/plan-options";
import {
  UPLOAD_FIELD_LABELS,
  extractPlanFieldsFromText,
  extractLessonsFromText,
  extractSectionsFromText,
} from "../utils/planDocExtract";
import "../curriculum.css";

// Counts non-empty answers across however many sections a schema has --
// used only for the "已从文件中识别..." status message below, not for any
// actual decision (see hasAnySectionContent in planDocExtract.js for the
// boolean version used elsewhere).
const countSectionAnswers = (schema, answers) => {
  const sections = (schema && schema.sections) || [];
  const hasVal = (v) => v != null && String(v).trim() !== "";
  if (sections.length > 1) {
    return sections.reduce((sum, s) => sum + Object.values((answers && answers[s.key]) || {}).filter(hasVal).length, 0);
  }
  return Object.values(answers || {}).filter(hasVal).length;
};

const emptyForm = {
  title: "",
  theme: "",
  grade: "",
  year: "",
  season: "",
  plannedLessonCount: "",
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
  // "从文件导入" is purely an initialization convenience, not a persisted plan
  // state -- every plan is always planMode='online' (see onSubmit), so it can
  // always be edited section-by-section afterward regardless of how it started.
  // Toggled by a button (see JSX below) rather than tied to any saved field.
  // The picked file only ever seeds form fields and the WHY/WHAT/HOW-
  // equivalent body (best-effort, see extractPlanFieldsFromText/
  // extractSectionsFromText, driven by whichever plan_design template is
  // currently active) -- it's never itself attached as an artifact;
  // 课程设计文件 is rendered on the fly from the plan's (possibly pre-filled)
  // online content, never stored (see plan-detail.component.js's DesignDocPanel).
  const [showFileImport, setShowFileImport] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadFormData, setUploadFormData] = useState(null);
  const uploadFileInputRef = useRef(null);

  // Only teachers author a new plan -- managers/experts manage existing
  // cases (suspend/delete/promote/review) but don't create their own, matching
  // plan.routes.js's isTeacher-only gate on POST /api/plans.
  const canCreate = !excellentOnly && AuthService.isTeacher();
  const stylishPublic = excellentOnly || !AuthService.isLogin();
  // A teacher never has a legitimate reason to browse "all plans" -- the
  // backend only ever shows them their own plans plus 优秀案例 (see
  // plan.controller.js#findAll's visibility rule), so treat any /plans visit
  // as "mine" for a teacher regardless of the mine= query param, not just the
  // ?mine=true landing link. Otherwise a teacher who reaches bare /plans
  // (e.g. by editing the URL) sees their own just-created ordinary plan
  // vanish, since it isn't excellent and isn't "mine" without this. Excluded
  // when excellentOnly (the public gallery) or statusFilter (an expert's
  // 待点评 queue) is in play -- neither of those is about plan ownership.
  // A manager is only ever interested in all plans, so there's no "只看我的"
  // toggle to offer them either (removed; previously shown to admin only).
  const effectiveMineOnly = mineOnly || (!excellentOnly && !statusFilter && AuthService.isTeacher());

  // Manager's bare /plans and expert's /plans?status=submitted both land
  // here, and both get the year-学期 -> teacher explorer (plans-hierarchy.
  // component.js) instead of this component's own flat search/paginate/grid
  // -- a teacher's own list (effectiveMineOnly) and the public 优秀案例
  // gallery (excellentOnly) are unaffected, they keep the flat view.
  const isManagerOrExpertView = (AuthService.isAdmin() || AuthService.isExpert()) && !excellentOnly && !effectiveMineOnly;

  const isOwnerOf = (item) => AuthService.isTeacher() && String(item.teacherId) === String(currentUserId());
  // Editing a plan's content is owner-only, no admin bypass -- managers can
  // suspend/delete/promote/leave notes (see below), but not edit case content.
  const canEditItem = (item) => !item.suspended && isOwnerOf(item);
  const canDeleteItem = (item) => AuthService.isAdmin() || isOwnerOf(item);

  const retrieveAll = useCallback(async () => {
    // The hierarchy view (see isManagerOrExpertView) fetches its own data
    // independently -- this component's own paginated fetch would just be
    // wasted work when its result is never rendered.
    if (isManagerOrExpertView) return;
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
  }, [page, pageSize, keyword, searchYear, searchTheme, searchGrade, effectiveMineOnly, statusFilter, excellentOnly, isManagerOrExpertView]);

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
        season: form.season || null,
        plannedLessonCount: form.plannedLessonCount ? Number(form.plannedLessonCount) : null,
        // Always 'online' -- 从文件导入 (see showFileImport) is only ever how a
        // plan gets its initial content, never a persisted state, so every plan
        // stays section-by-section editable regardless of how it started.
        planMode: "online",
      };
      if (!editingId && uploadFormData) {
        payload.planFormData = uploadFormData;
      }
      if (editingId) {
        await PlanDataService.update(editingId, payload);
        setMessage("课程设计更新成功。");
      } else {
        await PlanDataService.create(payload);
        setMessage("课程设计创建成功。");
      }
      setEditingId(null);
      setForm(emptyForm);
      setShowFileImport(false);
      setUploadFile(null);
      setUploadStatus("");
      setUploadFormData(null);
      setIsEditorOpen(false);
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存失败。");
    }
  };

  // Rendered on the fly from whichever template_versions row is currently
  // active for that key (see template.controller.js#downloadBlank) --
  // always matches what an admin last published in 模板管理, no static file
  // in public/ to fall out of sync with it.
  const downloadTemplateFile = async (templateKey) => {
    try {
      const resp = await TemplateDataService.downloadBlank(templateKey);
      const url = window.URL.createObjectURL(
        new Blob([resp.data], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${templateKey === "plan_design" ? "乡土课程设计方案模版" : "课时实施记录模版"}.docx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.log(e);
      setMessage("模板下载失败。");
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
      const text = result.value || "";
      // Also converted to HTML so extractSectionsFromText can walk the
      // template's actual table structure instead of just the flattened text --
      // see tableRowTexts.
      const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
      const html = htmlResult.value || "";

      const extracted = extractPlanFieldsFromText(text);
      const matchedLabels = Object.keys(extracted).map((k) => UPLOAD_FIELD_LABELS[k]);
      setForm((prev) => ({ ...prev, ...extracted }));

      // The currently-active plan_design template -- a brand-new plan has
      // no PlanTemplateVersion of its own yet (that gets stamped by
      // plan.controller.js#create moments later, from this same active
      // version), so this is the only schema available to extract against.
      const schemaResp = await TemplateDataService.getActive("plan_design");
      const schema = schemaResp.data.schemaJson;
      const bodyExtracted = extractSectionsFromText(text, html, schema);
      const bodyFieldCount = countSectionAnswers(schema, bodyExtracted);
      const lessons = extractLessonsFromText(text);
      const hasOnlineContent = bodyFieldCount > 0 || lessons.length > 0;
      setUploadFormData(hasOnlineContent ? { ...bodyExtracted, lessons } : null);

      const parts = [];
      if (matchedLabels.length > 0) parts.push(matchedLabels.join("、"));
      if (bodyFieldCount > 0) parts.push(`课程设计方案 WHY/WHAT/HOW 共 ${bodyFieldCount} 项内容`);
      if (lessons.length > 0) parts.push(`分课时设计共 ${lessons.length} 课时`);
      setUploadStatus(
        parts.length > 0
          ? `已从文件中识别：${parts.join("；")}${hasOnlineContent ? "，课程设计将以在线填写形式创建" : ""}，请核对后提交。`
          : "未能从文件中自动识别课程信息，请手动填写。"
      );
    } catch (err) {
      console.log(err);
      setUploadStatus("文件解析失败，请手动填写课程信息。");
    }
  };

  const openCreateEditor = () => {
    setEditingId(null);
    setForm({ ...emptyForm, year: String(new Date().getFullYear()), season: currentSeason(), theme: searchTheme });
    setShowFileImport(false);
    setUploadFile(null);
    setUploadStatus("");
    setUploadFormData(null);
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowFileImport(false);
    setUploadFile(null);
    setUploadStatus("");
    setUploadFormData(null);
    setIsEditorOpen(false);
  };

  const onEdit = (item) => {
    setEditingId(item.id);
    setForm({
      title: item.title || "",
      theme: item.theme || "",
      grade: item.grade || "",
      year: item.year ? String(item.year) : "",
      season: item.season || "",
      plannedLessonCount: item.plannedLessonCount ? String(item.plannedLessonCount) : "",
    });
    setShowFileImport(false);
    setUploadFile(null);
    setUploadStatus("");
    setUploadFormData(null);
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
          {heading}
          {/* totalItems tracks this component's own paginated fetch, which
              isManagerOrExpertView skips entirely (see retrieveAll) -- the
              hierarchy view's own tree conveys scale instead. */}
          {!isManagerOrExpertView && `（总数：${totalItems}）`}
        </h4>
      )}

      {isManagerOrExpertView ? (
        <PlansHierarchy statusFilter={statusFilter} />
      ) : (
        <>
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
          <button className="btn btn-primary mr-3" type="button" onClick={openCreateEditor}>
            新增乡土课程设计
          </button>
          <button className="btn btn-link p-0 mr-3" type="button" onClick={() => downloadTemplateFile("plan_design")}>
            下载乡土课程设计方案模版
          </button>
          <button className="btn btn-link p-0" type="button" onClick={() => downloadTemplateFile("lesson_execution")}>
            下载乡土课程实施记录模版
          </button>
        </div>
      )}

      {message && <div className="alert alert-info py-2">{message}</div>}

      {plans.length === 0 ? (
        <div className="pl-empty">暂无数据</div>
      ) : (
        <div className="pl-plan-grid">
          {plans.map((item) => (
            <PlanCard
              key={item.id}
              item={item}
              canEdit={canEditItem(item)}
              canDelete={canDeleteItem(item)}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggleExcellent={toggleExcellent}
              onToggleSuspend={toggleSuspend}
            />
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
                <label>学期</label>
                {/* No blank/required option -- season is nullable at the
                    backend (existing plans predate this field), always
                    defaulted to the current 学期 for a new plan (see
                    openCreateEditor), so there's nothing meaningful for a
                    blank choice to represent here. */}
                <select className="form-control" name="season" value={form.season} onChange={onChange}>
                  {PLAN_SEASONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
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
              {!editingId && (
                <div className="form-group">
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    onClick={() => setShowFileImport((v) => !v)}
                  >
                    {showFileImport ? "取消从文件导入" : "从文件导入内容"}
                  </button>
                </div>
              )}
              {showFileImport && !editingId && (
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
