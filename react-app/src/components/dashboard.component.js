import React, { useEffect, useMemo, useState } from "react";
import { Link, useHistory, useLocation } from "react-router-dom";
import Select from "react-select";
import DashboardDataService from "../services/dashboard.service";
import AuthService from "../services/auth.service";
import PlanDataService from "../services/plan.service";
import { PLAN_THEMES } from "../constants/plan-options";
import { SCHOOLS, schoolFilterOption } from "../constants/school-options";
import "../curriculum.css";

// Same as plans-hierarchy.component.js's -- the filter bar here starts from
// 全部乡土课程's so the two pages narrow down plans the same way.
const formatSchoolOptionLabel = (option) => (
  <div>
    <div>{option.label}</div>
    {option.address && <div style={{ fontSize: "0.85em", color: "#6c757d" }}>{option.address}</div>}
  </div>
);

const seasonRank = (season) => (season === "秋季" ? 2 : season === "春季" ? 1 : 0);
const termKey = (p) => `${p.year}|${p.season || ""}`;
const termLabel = (year, season) => `${year}年 ${season || "未设置学期"}`;

const EXPORT_FIELDS_STORAGE_KEY = "dashboardExportFields";

const errorText = (e) => (e.response && e.response.data && e.response.data.message) || e.message;

// Blank input = no bound; anything else is clamped to a number.
const parseBound = (text) => (text === "" || text === null || Number.isNaN(Number(text)) ? null : Number(text));

const sortValue = {
  school: (r) => r.schoolName || "",
  completion: (r) => r.completion.overall,
  aiScore: (r) => (r.aiScore ? r.aiScore.totalScore : null),
};

// Unscored plans always sort last, whichever direction AI 分数 is sorted in
// (same rule as ai-scores.component.js).
const compareBy = (sortKey, sortDir) => (a, b) => {
  const dir = sortDir === "asc" ? 1 : -1;
  const va = sortValue[sortKey](a);
  const vb = sortValue[sortKey](b);
  if (sortKey === "school") return dir * va.localeCompare(vb, "zh") || a.teacherName.localeCompare(b.teacherName, "zh");
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  return dir * (va - vb);
};

const completionClass = (pct) => (pct >= 80 ? "bg-success" : pct >= 40 ? "bg-info" : "bg-warning");

const scoreClass = (score) => (score >= 85 ? "text-success" : score >= 60 ? "" : "text-danger");

const readStoredExportFields = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(EXPORT_FIELDS_STORAGE_KEY));
    return Array.isArray(stored) ? stored : null;
  } catch (e) {
    return null;
  }
};

// 数据看板 (admins and experts): every plan in one sortable/filterable table with
// its 完成度 (see backend services/planCompletion.js), newest AI 打分 and
// expert reviews, exportable to Excel with a chosen set of columns.
const Dashboard = () => {
  const allowed = AuthService.isAdmin() || AuthService.isExpert();
  const history = useHistory();
  const location = useLocation();

  const [rows, setRows] = useState([]);
  const [exportFields, setExportFields] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [showExportConfig, setShowExportConfig] = useState(false);
  // planId whose AI 打分 breakdown is expanded under its row.
  const [expandedScore, setExpandedScore] = useState(null);
  const [selectedExportFields, setSelectedExportFields] = useState(readStoredExportFields);

  // Filter + sort state, restored from / kept in sync with the URL -- same
  // pattern as plans-hierarchy.component.js, so returning from a plan (its
  // 返回 is a history.goBack()) lands back on the same filtered, sorted view.
  const initialParams = useMemo(() => new URLSearchParams(location.search || ""), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [filterTerm, setFilterTerm] = useState(() => initialParams.get("term") || "");
  const [filterTeacherName, setFilterTeacherName] = useState(() => initialParams.get("teacherName") || "");
  const [filterSchoolName, setFilterSchoolName] = useState(() => initialParams.get("schoolName") || "");
  const [filterTheme, setFilterTheme] = useState(() => initialParams.get("theme") || "");
  // "" (all) | "yes" | "no"
  const [filterSubmitted, setFilterSubmitted] = useState(() => initialParams.get("submitted") || "");
  const [filterAiReviewed, setFilterAiReviewed] = useState(() => initialParams.get("aiReviewed") === "1");
  const [filterExpertReviewed, setFilterExpertReviewed] = useState(() => initialParams.get("expertReviewed") === "1");
  const [completionMin, setCompletionMin] = useState(() => initialParams.get("completionMin") || "");
  const [completionMax, setCompletionMax] = useState(() => initialParams.get("completionMax") || "");
  // "" (all) | "scored" | "unscored"
  const [filterAiScored, setFilterAiScored] = useState(() => initialParams.get("aiScored") || "");
  const [aiScoreMin, setAiScoreMin] = useState(() => initialParams.get("aiScoreMin") || "");
  const [aiScoreMax, setAiScoreMax] = useState(() => initialParams.get("aiScoreMax") || "");
  const [sortKey, setSortKey] = useState(() => (sortValue[initialParams.get("sort")] ? initialParams.get("sort") : "school"));
  const [sortDir, setSortDir] = useState(() => (initialParams.get("dir") === "desc" ? "desc" : "asc"));

  const [themeOptions, setThemeOptions] = useState(PLAN_THEMES);
  useEffect(() => {
    PlanDataService.getOptions()
      .then((resp) => {
        if (Array.isArray(resp.data && resp.data.themes) && resp.data.themes.length > 0) setThemeOptions(resp.data.themes);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!allowed) return;
    DashboardDataService.getAll()
      .then((res) => {
        setRows(res.data.rows || []);
        setExportFields(res.data.exportFields || []);
      })
      .catch((e) => setMessage(errorText(e)))
      .then(() => setLoaded(true));
  }, [allowed]);

  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    const setOrDelete = (key, value) => (value ? params.set(key, value) : params.delete(key));
    setOrDelete("term", filterTerm);
    setOrDelete("teacherName", filterTeacherName);
    setOrDelete("schoolName", filterSchoolName);
    setOrDelete("theme", filterTheme);
    setOrDelete("submitted", filterSubmitted);
    setOrDelete("aiReviewed", filterAiReviewed ? "1" : "");
    setOrDelete("expertReviewed", filterExpertReviewed ? "1" : "");
    setOrDelete("completionMin", completionMin);
    setOrDelete("completionMax", completionMax);
    setOrDelete("aiScored", filterAiScored);
    setOrDelete("aiScoreMin", aiScoreMin);
    setOrDelete("aiScoreMax", aiScoreMax);
    setOrDelete("sort", sortKey === "school" ? "" : sortKey);
    setOrDelete("dir", sortDir === "asc" ? "" : sortDir);
    const nextSearch = params.toString();
    if (nextSearch !== (location.search || "").replace(/^\?/, "")) {
      history.replace({ pathname: location.pathname, search: nextSearch });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterTerm,
    filterTeacherName,
    filterSchoolName,
    filterTheme,
    filterSubmitted,
    filterAiReviewed,
    filterExpertReviewed,
    completionMin,
    completionMax,
    filterAiScored,
    aiScoreMin,
    aiScoreMax,
    sortKey,
    sortDir,
  ]);

  // Only schools/terms that actually have a plan -- same "no dead-end
  // options" narrowing as 全部乡土课程's school dropdown.
  const schoolOptions = useMemo(() => {
    const codes = new Set(rows.map((r) => r.schoolCode).filter((c) => c !== null && c !== undefined).map(String));
    return SCHOOLS.filter((s) => codes.has(String(s.code))).map((s) => ({ value: s.code, label: s.name, address: s.address }));
  }, [rows]);

  const termOptions = useMemo(() => {
    const terms = new Map();
    rows.forEach((r) => terms.set(termKey(r), { key: termKey(r), year: r.year, season: r.season }));
    return Array.from(terms.values()).sort((a, b) => (a.year !== b.year ? b.year - a.year : seasonRank(b.season) - seasonRank(a.season)));
  }, [rows]);

  const visibleRows = useMemo(() => {
    const teacherQuery = filterTeacherName.trim().toLowerCase();
    const schoolQuery = filterSchoolName.trim().toLowerCase();
    const cMin = parseBound(completionMin);
    const cMax = parseBound(completionMax);
    const sMin = parseBound(aiScoreMin);
    const sMax = parseBound(aiScoreMax);
    const scoreBounded = sMin !== null || sMax !== null;
    return rows
      .filter((r) => {
        const pct = r.completion.overall;
        const score = r.aiScore ? r.aiScore.totalScore : null;
        return (
          (!filterTerm || termKey(r) === filterTerm) &&
          (!teacherQuery || (r.teacherName || "").toLowerCase().includes(teacherQuery)) &&
          (!schoolQuery || (r.schoolName || "").toLowerCase().includes(schoolQuery)) &&
          (!filterTheme || r.theme === filterTheme) &&
          (!filterSubmitted || (filterSubmitted === "yes") === r.submitted) &&
          (!filterAiReviewed || r.aiReviewed) &&
          (!filterExpertReviewed || r.expertReviews.count > 0) &&
          (cMin === null || pct >= cMin) &&
          (cMax === null || pct <= cMax) &&
          (filterAiScored !== "scored" || score !== null) &&
          (filterAiScored !== "unscored" || score === null) &&
          // A score range only makes sense for scored plans.
          (!scoreBounded || (score !== null && (sMin === null || score >= sMin) && (sMax === null || score <= sMax)))
        );
      })
      .sort(compareBy(sortKey, sortDir));
  }, [
    rows,
    filterTerm,
    filterTeacherName,
    filterSchoolName,
    filterTheme,
    filterSubmitted,
    filterAiReviewed,
    filterExpertReviewed,
    completionMin,
    completionMax,
    filterAiScored,
    aiScoreMin,
    aiScoreMax,
    sortKey,
    sortDir,
  ]);

  // First click sorts in the column's natural direction (学校 A→Z, 完成度 and
  // AI 分数 high→low); clicking the active column again flips it.
  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "school" ? "asc" : "desc");
    }
  };
  const sortIcon = (key) => (sortKey !== key ? "fa-sort text-muted" : sortDir === "asc" ? "fa-sort-up" : "fa-sort-down");
  const sortableTh = (key, label, style) => (
    <th style={{ cursor: "pointer", whiteSpace: "nowrap", ...style }} onClick={() => toggleSort(key)}>
      {label} <i className={`fas ${sortIcon(key)} ml-1`} />
    </th>
  );

  const clearFilters = () => {
    setFilterTerm("");
    setFilterTeacherName("");
    setFilterSchoolName("");
    setFilterTheme("");
    setFilterSubmitted("");
    setFilterAiReviewed(false);
    setFilterExpertReviewed(false);
    setCompletionMin("");
    setCompletionMax("");
    setFilterAiScored("");
    setAiScoreMin("");
    setAiScoreMax("");
  };

  // Stored choice (if any) wins over the server's defaults; keys no longer
  // offered by the server are dropped.
  const effectiveExportFields = useMemo(() => {
    const offered = new Set(exportFields.map((f) => f.key));
    if (selectedExportFields) return selectedExportFields.filter((k) => offered.has(k));
    return exportFields.filter((f) => f.defaultOn).map((f) => f.key);
  }, [exportFields, selectedExportFields]);

  const updateExportFields = (keys) => {
    setSelectedExportFields(keys);
    try {
      localStorage.setItem(EXPORT_FIELDS_STORAGE_KEY, JSON.stringify(keys));
    } catch (e) {
      // Not remembered across visits -- still applies to this one.
    }
  };
  const toggleExportField = (key) => {
    const current = new Set(effectiveExportFields);
    if (current.has(key)) current.delete(key);
    else current.add(key);
    // Kept in the server's column order, not click order.
    updateExportFields(exportFields.map((f) => f.key).filter((k) => current.has(k)));
  };

  const exportExcel = async () => {
    setMessage("");
    setExporting(true);
    try {
      const resp = await DashboardDataService.exportExcel(
        visibleRows.map((r) => r.planId),
        effectiveExportFields
      );
      const url = window.URL.createObjectURL(
        new Blob([resp.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      );
      const link = document.createElement("a");
      link.href = url;
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      link.setAttribute("download", `乡土课程数据看板_${stamp}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      // responseType is arraybuffer, so a JSON error body arrives as bytes.
      let text = errorText(e);
      try {
        if (e.response && e.response.data instanceof ArrayBuffer) {
          text = JSON.parse(new TextDecoder().decode(e.response.data)).message || text;
        }
      } catch (ignored) {
        // keep errorText's message
      }
      setMessage(text || "导出失败。");
    } finally {
      setExporting(false);
    }
  };

  if (!allowed) {
    return <div className="alert alert-warning">数据看板仅对管理员和专家开放。</div>;
  }

  const avg = (values) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);
  const avgCompletion = avg(visibleRows.map((r) => r.completion.overall));
  const scoredRows = visibleRows.filter((r) => r.aiScore);
  const avgScore = avg(scoredRows.map((r) => r.aiScore.totalScore));

  return (
    <div className="container-fluid px-lg-5">
      <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap">
        <h4 className="mb-0">数据看板</h4>
        <div className="position-relative">
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm mr-2"
            onClick={() => setShowExportConfig((prev) => !prev)}
          >
            <i className="fas fa-columns mr-1" />
            导出字段（{effectiveExportFields.length}）
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={exporting || visibleRows.length === 0 || effectiveExportFields.length === 0}
            onClick={exportExcel}
          >
            <i className="fas fa-file-excel mr-1" />
            {exporting ? "导出中..." : `导出 Excel（${visibleRows.length} 行）`}
          </button>
          {showExportConfig && (
            <div className="card shadow-sm pl-dashboard-export-config">
              <div className="card-body p-2">
                <div className="d-flex justify-content-between align-items-center mb-2">
                  <b className="small">选择导出到 Excel 的字段</b>
                  <button type="button" className="close" onClick={() => setShowExportConfig(false)}>
                    <span>&times;</span>
                  </button>
                </div>
                <div className="small mb-2">
                  <button type="button" className="btn btn-link btn-sm p-0 mr-3" onClick={() => updateExportFields(exportFields.map((f) => f.key))}>
                    全选
                  </button>
                  <button type="button" className="btn btn-link btn-sm p-0 mr-3" onClick={() => updateExportFields([])}>
                    全不选
                  </button>
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0"
                    onClick={() => updateExportFields(exportFields.filter((f) => f.defaultOn).map((f) => f.key))}
                  >
                    恢复默认
                  </button>
                </div>
                <div className="pl-dashboard-export-fields">
                  {exportFields.map((f) => (
                    <div className="custom-control custom-checkbox" key={f.key}>
                      <input
                        type="checkbox"
                        className="custom-control-input"
                        id={`exportField-${f.key}`}
                        checked={effectiveExportFields.includes(f.key)}
                        onChange={() => toggleExportField(f.key)}
                      />
                      <label className="custom-control-label small" htmlFor={`exportField-${f.key}`}>
                        {f.label}
                      </label>
                    </div>
                  ))}
                </div>
                <div className="small text-muted mt-2">导出当前筛选结果，按当前排序。</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {message && <div className="alert alert-danger py-2">{message}</div>}

      <div className="form-row">
        <div className="form-group col-md-3">
          <label>学期筛选</label>
          <select className="form-control" value={filterTerm} onChange={(e) => setFilterTerm(e.target.value)}>
            <option value="">全部学期</option>
            {termOptions.map((t) => (
              <option key={t.key} value={t.key}>
                {termLabel(t.year, t.season)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group col-md-3">
          <label>教师姓名筛选</label>
          <input
            className="form-control"
            placeholder="按教师姓名搜索"
            value={filterTeacherName}
            onChange={(e) => setFilterTeacherName(e.target.value)}
          />
        </div>
        <div className="form-group col-md-3">
          <label htmlFor="dashboardSchoolFilter">学校名称筛选</label>
          <Select
            inputId="dashboardSchoolFilter"
            options={schoolOptions}
            value={schoolOptions.find((o) => o.label === filterSchoolName) || null}
            onChange={(option) => setFilterSchoolName(option ? option.label : "")}
            placeholder="搜索学校（名称/代码）"
            formatOptionLabel={formatSchoolOptionLabel}
            filterOption={schoolFilterOption}
            isClearable
          />
        </div>
        <div className="form-group col-md-3">
          <label>主题筛选</label>
          <select className="form-control" value={filterTheme} onChange={(e) => setFilterTheme(e.target.value)}>
            <option value="">全部主题</option>
            {themeOptions.map((theme) => (
              <option key={theme} value={theme}>
                {theme}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="form-group col-md-2">
          <label>提交状态</label>
          <select className="form-control" value={filterSubmitted} onChange={(e) => setFilterSubmitted(e.target.value)}>
            <option value="">全部</option>
            <option value="yes">已提交</option>
            <option value="no">未提交（草稿）</option>
          </select>
        </div>
        <div className="form-group col-md-3">
          <label>完成度（%）</label>
          <div className="d-flex align-items-center">
            <input
              className="form-control"
              type="number"
              min="0"
              max="100"
              placeholder="最低"
              value={completionMin}
              onChange={(e) => setCompletionMin(e.target.value)}
            />
            <span className="mx-2">–</span>
            <input
              className="form-control"
              type="number"
              min="0"
              max="100"
              placeholder="最高"
              value={completionMax}
              onChange={(e) => setCompletionMax(e.target.value)}
            />
          </div>
        </div>
        <div className="form-group col-md-2">
          <label>AI 打分</label>
          <select className="form-control" value={filterAiScored} onChange={(e) => setFilterAiScored(e.target.value)}>
            <option value="">全部</option>
            <option value="scored">已打分</option>
            <option value="unscored">未打分</option>
          </select>
        </div>
        <div className="form-group col-md-3">
          <label>AI 分数</label>
          <div className="d-flex align-items-center">
            <input
              className="form-control"
              type="number"
              min="0"
              max="100"
              placeholder="最低"
              value={aiScoreMin}
              onChange={(e) => setAiScoreMin(e.target.value)}
            />
            <span className="mx-2">–</span>
            <input
              className="form-control"
              type="number"
              min="0"
              max="100"
              placeholder="最高"
              value={aiScoreMax}
              onChange={(e) => setAiScoreMax(e.target.value)}
            />
          </div>
        </div>
        <div className="form-group col-md-2 d-flex align-items-end">
          <button type="button" className="btn btn-link px-0" onClick={clearFilters}>
            清除筛选
          </button>
        </div>
      </div>
      <div className="pl-filter-bar mb-3">
        <button
          type="button"
          className={`pl-filter-toggle pl-filter-toggle-ai ${filterAiReviewed ? "is-active" : ""}`}
          onClick={() => setFilterAiReviewed((prev) => !prev)}
        >
          AI已点评
        </button>
        <button
          type="button"
          className={`pl-filter-toggle pl-filter-toggle-expert ${filterExpertReviewed ? "is-active" : ""}`}
          onClick={() => setFilterExpertReviewed((prev) => !prev)}
        >
          专家已点评
        </button>
      </div>

      {loaded && (
        <p className="small mb-2">
          {visibleRows.length === rows.length ? `共 ${rows.length} 个课程` : `筛选出 ${visibleRows.length} / ${rows.length} 个课程`}
          {avgCompletion !== null && `，平均完成度 ${avgCompletion}%`}
          {`，已打分 ${scoredRows.length} 个`}
          {avgScore !== null && `，AI 平均分 ${avgScore}`}。
          <span className="text-muted ml-2" title="基本信息 10% + 课程设计 40% + 分课时设计 20% + 课时实施 30%，各部分按模板字段的填写比例计算">
            <i className="fas fa-info-circle mr-1" />
            完成度 = 基本信息 10% + 课程设计 40% + 分课时设计 20% + 课时实施 30%（按模板字段填写比例）
          </span>
        </p>
      )}

      <table className="table table-bordered table-sm table-hover">
        <thead className="thead-light">
          <tr>
            <th style={{ width: "9%" }}>教师</th>
            {sortableTh("school", "学校", { width: "18%" })}
            <th>课程</th>
            <th style={{ width: "7%" }}>是否提交</th>
            {sortableTh("completion", "完成度", { width: "14%" })}
            {sortableTh("aiScore", "AI 分数", { width: "10%" })}
            <th style={{ width: "13%" }}>专家点评</th>
          </tr>
        </thead>
        <tbody>
          {!loaded && (
            <tr>
              <td colSpan={7} className="text-center text-muted small">
                加载中...
              </td>
            </tr>
          )}
          {loaded && visibleRows.length === 0 && (
            <tr>
              <td colSpan={7} className="text-center text-muted small">
                没有符合筛选条件的课程。
              </td>
            </tr>
          )}
          {visibleRows.map((r) => {
            const c = r.completion;
            const s = r.aiScore;
            const er = r.expertReviews;
            return (
              <React.Fragment key={r.planId}>
                <tr>
                  <td className="small">{r.teacherName}</td>
                  <td className="small">{r.schoolName}</td>
                  <td>
                    <Link to={`/plans/${r.planId}`}>{r.title}</Link>
                    {r.suspended && <span className="badge badge-secondary ml-1">已停用</span>}
                    {r.isExcellentCase && <span className="badge badge-warning ml-1">优秀案例</span>}
                    <div className="small text-muted">
                      {[termLabel(r.year, r.season), r.grade, r.theme].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td className="small">
                    {r.submitted ? <span className="badge badge-success">已提交</span> : <span className="badge badge-light border">草稿</span>}
                  </td>
                  <td
                    className="small"
                    title={`基本信息 ${c.basic}% · 课程设计 ${c.design}% · 分课时设计 ${c.lessonDesign}% · 课时实施 ${c.execution}%（${c.lessonCount} 课时）`}
                  >
                    <div className="d-flex align-items-center">
                      <div className="progress flex-grow-1 mr-2" style={{ height: 8 }}>
                        <div className={`progress-bar ${completionClass(c.overall)}`} style={{ width: `${c.overall}%` }} />
                      </div>
                      <b>{c.overall}%</b>
                    </div>
                  </td>
                  <td className="small">
                    {s ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-link btn-sm p-0"
                          title="查看各维度打分理由"
                          onClick={() => setExpandedScore(expandedScore === r.planId ? null : r.planId)}
                        >
                          <b className={scoreClass(s.totalScore)}>{s.totalScore}</b>
                          <i className={`fas fa-chevron-${expandedScore === r.planId ? "up" : "down"} ml-1 small`} />
                        </button>
                        {s.outdatedStandard && (
                          <div>
                            <span className="badge badge-warning">旧标准 #{s.standardId}</span>
                          </div>
                        )}
                        {s.contentChanged && (
                          <div>
                            <span className="badge badge-secondary">内容已修改</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted">未打分</span>
                    )}
                  </td>
                  <td className="small">
                    {er.count > 0 ? (
                      <>
                        <Link to={`/plans/${r.planId}?view=${er.scope === "implementation" ? "executionReviews" : "reviews"}`}>
                          {er.count} 条点评
                        </Link>
                        {er.averageScore !== null && <span className="ml-1">· 均分 {er.averageScore}</span>}
                        {er.reviewers.length > 0 && <div className="text-muted">{er.reviewers.join("、")}</div>}
                      </>
                    ) : (
                      <span className="text-muted">暂无</span>
                    )}
                  </td>
                </tr>
                {/* Same breakdown as the AI 打分 page's expanded row -- shown
                    here rather than linking there, since that page lists
                    submitted plans only and a draft can carry a score too. */}
                {s && expandedScore === r.planId && (
                  <tr>
                    <td colSpan={7} className="bg-light small">
                      {s.summary && <p className="mb-2">{s.summary}</p>}
                      {(s.dimensionScores || []).map((d) => (
                        <div key={d.name} className="mb-1">
                          <b>
                            {d.name}（{d.score}/{d.weight}
                            {d.level && `，${d.level}`}）
                          </b>
                          ：{d.rationale}
                        </div>
                      ))}
                      <div className="text-muted mt-2">
                        标准版本 #{s.standardId} · 打分时间 {new Date(s.createdAt).toLocaleString()} ·{" "}
                        <Link to="/ai-review/scores">AI 打分</Link>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default Dashboard;
