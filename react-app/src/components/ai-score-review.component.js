import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useHistory, useLocation } from "react-router-dom";
import Select from "react-select";
import AiReviewDataService from "../services/ai-review.service";
import AuthService from "../services/auth.service";
import PlanDataService from "../services/plan.service";
import { PLAN_THEMES } from "../constants/plan-options";
import { SCHOOLS, schoolFilterOption } from "../constants/school-options";
import "../curriculum.css";

const POLL_INTERVAL_MS = 3000;

// Same as plans-hierarchy.component.js's -- the filter bar here mirrors
// 全部乡土课程's so the two pages narrow down plans the same way.
const formatSchoolOptionLabel = (option) => (
  <div>
    <div>{option.label}</div>
    {option.address && <div style={{ fontSize: "0.85em", color: "#6c757d" }}>{option.address}</div>}
  </div>
);

const UNASSIGNED_SCHOOL_NAME = "未分配学校";
const seasonRank = (season) => (season === "秋季" ? 2 : season === "春季" ? 1 : 0);
const termKey = (p) => `${p.year}|${p.season || ""}`;
const termLabel = (year, season) => `${year}年 ${season || "未设置学期"}`;

// Text columns sort A→Z first, numeric ones high→low (see toggleSort);
// unscored plans always sort last on 总分, whichever direction.
const TEXT_SORT_KEYS = ["title", "school"];
const SORT_KEYS = ["title", "school", "completion", "score"];
const compareBy = (sortKey, sortDir) => (a, b) => {
  const dir = sortDir === "asc" ? 1 : -1;
  if (sortKey === "title") return dir * (a.title || "").localeCompare(b.title || "", "zh");
  if (sortKey === "school") {
    return (
      dir *
      ((a.schoolName || "").localeCompare(b.schoolName || "", "zh") ||
        (a.teacherName || "").localeCompare(b.teacherName || "", "zh"))
    );
  }
  if (sortKey === "completion") return dir * (a.completion.overall - b.completion.overall);
  if (!a.score && !b.score) return 0;
  if (!a.score) return 1;
  if (!b.score) return -1;
  return dir * (a.score.totalScore - b.score.totalScore);
};

// Blank bounds mean "no limit"; any 总分 bound leaves out unscored plans --
// "score ≥ 60" can't be judged for a plan with no score.
const num = (v) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const inRange = (value, min, max) => (min === null || value >= min) && (max === null || value <= max);

const errorText = (e) => (e.response && e.response.data && e.response.data.message) || e.message;

const formatElapsed = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
};

const scoreClass = (score, weight) => {
  const ratio = weight ? score / weight : 0;
  if (ratio >= 0.85) return "text-success";
  if (ratio >= 0.6) return "";
  return "text-danger";
};

const STEP_LABELS = { combined: "打分加点评中", score: "打分中", review: "点评中" };

// Filter + sort state lives in the URL (same pattern as
// plans-hierarchy.component.js), so returning from a plan -- its 返回 is a
// history.goBack() -- lands back on the same filtered, sorted view.
const URL_FILTERS = ["term", "teacherName", "schoolName", "theme", "minCompletion", "maxCompletion", "minScore", "maxScore"];
const URL_TOGGLES = ["aiReviewed", "expertReviewed", "pending"];

// AI -> AI 打分加点评: the one page for AI scores and reviews. Experts read
// it; admins (super included) can also run the batch that brings the
// plans it shows up to date. Every submitted plan is listed with its
// current AI evaluation -- a score and a review from the same turn, judged
// against the AI 点评标准 in effect, incl. the 目标一致性与完整性核查
// (backend aiPlanEvaluation.js) -- and whether that evaluation still needs
// a score and/or a review. Filtering and sorting happen here; a run is sent
// the ids of the plans shown, and the server only processes the ones that
// still need something (re-checked per plan), one LLM turn each.
const AiScoreReview = () => {
  const allowed = AuthService.isExpert() || AuthService.isAdmin();
  const canRun = AuthService.isAdmin();

  const [plans, setPlans] = useState([]);
  const [job, setJob] = useState(null);
  const [standard, setStandard] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(null);
  // Which half of the expanded plan's evaluation is shown: the score's
  // per-dimension rationale, or the AI 点评 -- read side by side here.
  const [expandedTab, setExpandedTab] = useState("score");

  const history = useHistory();
  const location = useLocation();
  const initialParams = useMemo(() => new URLSearchParams(location.search || ""), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [filters, setFilters] = useState(() => {
    const f = {};
    URL_FILTERS.forEach((k) => (f[k] = initialParams.get(k) || ""));
    URL_TOGGLES.forEach((k) => (f[k] = initialParams.get(k) === "1"));
    return f;
  });
  const [sortKey, setSortKey] = useState(() => (SORT_KEYS.includes(initialParams.get("sort")) ? initialParams.get("sort") : "score"));
  const [sortDir, setSortDir] = useState(() => (initialParams.get("dir") === "asc" ? "asc" : "desc"));
  const setFilter = (key) => (value) => setFilters((prev) => ({ ...prev, [key]: value }));

  const [themeOptions, setThemeOptions] = useState(PLAN_THEMES);
  useEffect(() => {
    PlanDataService.getOptions()
      .then((resp) => {
        if (Array.isArray(resp.data && resp.data.themes) && resp.data.themes.length > 0) setThemeOptions(resp.data.themes);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    const setOrDelete = (key, value) => (value ? params.set(key, value) : params.delete(key));
    URL_FILTERS.forEach((k) => setOrDelete(k, filters[k]));
    URL_TOGGLES.forEach((k) => setOrDelete(k, filters[k] ? "1" : ""));
    setOrDelete("sort", sortKey === "score" ? "" : sortKey);
    setOrDelete("dir", sortDir === "desc" ? "" : sortDir);
    const nextSearch = params.toString();
    if (nextSearch !== (location.search || "").replace(/^\?/, "")) {
      history.replace({ pathname: location.pathname, search: nextSearch });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sortKey, sortDir]);

  const refresh = useCallback(
    (opts) =>
      AiReviewDataService.getScoreReview(opts)
        .then((res) => {
          setPlans(res.data.plans);
          setJob(res.data.job);
          setStandard(res.data.standard);
          setLoaded(true);
        })
        .catch((e) => {
          setLoaded(true);
          setMessage(errorText(e));
        }),
    []
  );

  useEffect(() => {
    if (allowed) refresh();
  }, [allowed, refresh]);

  const running = !!(job && job.running);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => refresh({ background: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // Only schools/terms that actually have a submitted plan -- same
  // "no dead-end options" narrowing as 全部乡土课程's school dropdown.
  const schoolOptions = useMemo(() => {
    const codes = new Set(plans.map((p) => p.schoolCode).filter((c) => c !== null && c !== undefined).map(String));
    return SCHOOLS.filter((s) => codes.has(String(s.code))).map((s) => ({ value: s.code, label: s.name, address: s.address }));
  }, [plans]);

  const termOptions = useMemo(() => {
    const terms = new Map();
    plans.forEach((p) => terms.set(termKey(p), { key: termKey(p), year: p.year, season: p.season }));
    return Array.from(terms.values()).sort((a, b) =>
      a.year !== b.year ? b.year - a.year : seasonRank(b.season) - seasonRank(a.season)
    );
  }, [plans]);

  const visiblePlans = useMemo(() => {
    const teacherQuery = filters.teacherName.trim().toLowerCase();
    const schoolQuery = filters.schoolName.trim().toLowerCase();
    const minC = num(filters.minCompletion);
    const maxC = num(filters.maxCompletion);
    const minS = num(filters.minScore);
    const maxS = num(filters.maxScore);
    return plans
      .filter(
        (p) =>
          (!filters.term || termKey(p) === filters.term) &&
          (!teacherQuery || (p.teacherName || "").toLowerCase().includes(teacherQuery)) &&
          (!schoolQuery || (p.schoolName || UNASSIGNED_SCHOOL_NAME).toLowerCase().includes(schoolQuery)) &&
          (!filters.theme || p.theme === filters.theme) &&
          (!filters.aiReviewed || p.aiReviewed) &&
          (!filters.expertReviewed || p.expertReviewed) &&
          (!filters.pending || p.needsScore || p.needsReview) &&
          inRange(p.completion.overall, minC, maxC) &&
          (minS === null && maxS === null ? true : !!p.score && inRange(p.score.totalScore, minS, maxS))
      )
      .sort(compareBy(sortKey, sortDir));
  }, [plans, filters, sortKey, sortDir]);

  if (!allowed) {
    return <div className="alert alert-warning">AI 打分加点评仅对专家和管理员开放。</div>;
  }

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(TEXT_SORT_KEYS.includes(key) ? "asc" : "desc");
    }
  };
  const sortableHeader = (key, label, width) => (
    <th style={{ width, cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => toggleSort(key)}>
      {label}{" "}
      <i className={`fas ${sortKey !== key ? "fa-sort text-muted" : sortDir === "asc" ? "fa-sort-up" : "fa-sort-down"} ml-1`} />
    </th>
  );

  // Stats and the run follow the filters: picking a school shows that
  // school's average, and 开始 processes only the plans shown.
  const scored = visiblePlans.filter((p) => p.score);
  const average = scored.length
    ? Math.round((scored.reduce((sum, p) => sum + p.score.totalScore, 0) / scored.length) * 10) / 10
    : null;
  const pending = visiblePlans.filter((p) => p.needsScore || p.needsReview);
  const scoreCount = pending.filter((p) => p.needsScore).length;
  const reviewCount = pending.filter((p) => p.needsReview).length;
  const combinedCount = pending.filter((p) => p.needsScore && p.needsReview).length;
  const processed = job ? job.done + job.failed : 0;

  const run = () => {
    // Each plan is an LLM call writing a permanent score/review, so confirm
    // the counts before starting.
    if (
      !window.confirm(
        `将为当前显示的 ${pending.length} 个课程处理：其中 ${combinedCount} 个同时打分加点评，${scoreCount - combinedCount} 个仅打分，${
          reviewCount - combinedCount
        } 个仅点评（每个课程一次 AI 调用，约需 1-2 分钟），确定开始吗？`
      )
    )
      return;
    setMessage("");
    AiReviewDataService.runScoreReview(pending.map((p) => p.planId))
      .then((res) => setJob(res.data))
      .catch((e) => setMessage(errorText(e)))
      .then(refresh);
  };

  const rangeInput = (key, placeholder, max) => (
    <input
      type="number"
      className="form-control form-control-sm"
      style={{ width: 80 }}
      min={0}
      max={max}
      placeholder={placeholder}
      value={filters[key]}
      onChange={(e) => setFilter(key)(e.target.value)}
    />
  );

  return (
    <div className="container">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">AI 打分加点评</h4>
        {canRun && (
          <button className="btn btn-primary btn-sm" disabled={running || !standard || pending.length === 0} onClick={run}>
            开始（{pending.length} 个待处理课程）
          </button>
        )}
      </div>
      <p className="text-muted small">
        每个已提交课程都有一份 AI 打分与 AI 计划整体点评，出自同一次 AI 调用，
        {standard ? (
          <>
            依据当前生效的
            <Link to="/ai-review/standard" className="mx-1">AI 点评标准（版本 #{standard.id}）</Link>
            （满分 {standard.totalScore}），
          </>
        ) : (
          "依据当前生效的 AI 点评标准，"
        )}
        并核查课程的目标一致性与完整性。打分与点评在教师或专家「请AI点评」时生成
        {canRun ? "，也可在此为当前显示的待处理课程统一生成（每个课程只补齐所缺的部分）。" : "，或由管理员统一生成。"}
        设计完成度与<Link to="/dashboard" className="mx-1">数据看板</Link>一致。
      </p>

      {loaded && !standard && (
        <div className="alert alert-warning">
          尚未制定 AI 点评标准，请先在 <Link to="/ai-review/standard">AI 点评标准</Link> 中生成。
        </div>
      )}
      {message && <div className="alert alert-danger">{message}</div>}

      {running && (
        <div className="alert alert-info">
          <span className="spinner-border spinner-border-sm mr-2" role="status" />
          正在处理：已完成 {processed} / {job.queued}（已打分 {job.scored} / {job.scoreQueued}，已点评 {job.reviewed} /{" "}
          {job.reviewQueued}）
          <span className="ml-2 text-muted">已用时 {formatElapsed(now - new Date(job.startedAt).getTime())}</span>
          {job.inProgress && job.inProgress.length > 0 && (
            <div className="small mt-1">
              进行中：
              {job.inProgress.map((p) => `《${p.title || `课程 #${p.planId}`}》${STEP_LABELS[p.step] || ""}`).join("、")}
            </div>
          )}
          <div className="progress mt-2" style={{ height: 8 }}>
            <div
              className="progress-bar progress-bar-striped progress-bar-animated"
              style={{ width: `${Math.max(job.queued ? (processed / job.queued) * 100 : 100, 5)}%` }}
            />
          </div>
        </div>
      )}
      {canRun && job && !running && job.finishedAt && (
        <div className={`alert ${job.failed ? "alert-warning" : "alert-success"} small`}>
          最近一次运行完成于 {new Date(job.finishedAt).toLocaleString()}：
          {job.queued === 0
            ? "没有需要处理的课程。"
            : `新打分 ${job.scored} 个，新点评 ${job.reviewed} 个（其中 ${job.combined} 个同时完成）${
                job.failed ? `，失败 ${job.failed} 个` : ""
              }。`}
          {job.errors.map((e) => (
            <div key={e.planId}>
              《{e.title || `课程 #${e.planId}`}》：{e.message}
            </div>
          ))}
        </div>
      )}

      {loaded && plans.length === 0 && <p className="text-muted">暂无已提交的课程。</p>}

      {plans.length > 0 && (
        <>
          <div className="form-row">
            <div className="form-group col-md-3">
              <label>学期筛选</label>
              <select className="form-control" value={filters.term} onChange={(e) => setFilter("term")(e.target.value)}>
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
                value={filters.teacherName}
                onChange={(e) => setFilter("teacherName")(e.target.value)}
              />
            </div>
            <div className="form-group col-md-3">
              <label htmlFor="aiScoreReviewSchoolFilter">学校名称筛选</label>
              <Select
                inputId="aiScoreReviewSchoolFilter"
                options={schoolOptions}
                value={schoolOptions.find((o) => o.label === filters.schoolName) || null}
                onChange={(option) => setFilter("schoolName")(option ? option.label : "")}
                placeholder="搜索学校（名称/代码）"
                formatOptionLabel={formatSchoolOptionLabel}
                filterOption={schoolFilterOption}
                isClearable
              />
            </div>
            <div className="form-group col-md-3">
              <label>主题筛选</label>
              <select className="form-control" value={filters.theme} onChange={(e) => setFilter("theme")(e.target.value)}>
                <option value="">全部主题</option>
                {themeOptions.map((theme) => (
                  <option key={theme} value={theme}>
                    {theme}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="d-flex flex-wrap align-items-center mb-3">
            <div className="form-inline mr-4 mb-2">
              <label className="mr-2">设计完成度</label>
              {rangeInput("minCompletion", "不限", 100)}
              <span className="mx-2">% 至</span>
              {rangeInput("maxCompletion", "不限", 100)}
              <span className="ml-2">%</span>
            </div>
            <div className="form-inline mr-4 mb-2">
              <label className="mr-2">AI 设计分数</label>
              {rangeInput("minScore", "不限")}
              <span className="mx-2">至</span>
              {rangeInput("maxScore", "不限")}
            </div>
            <div className="pl-filter-bar mb-2">
              {/* No 已提交 toggle (unlike 全部乡土课程): every plan here is
                  already submitted. */}
              <button
                type="button"
                className={`pl-filter-toggle ${filters.pending ? "is-active" : ""}`}
                title="尚缺最新 AI 打分或 AI 点评的课程"
                onClick={() => setFilter("pending")(!filters.pending)}
              >
                待处理
              </button>
              <button
                type="button"
                className={`pl-filter-toggle pl-filter-toggle-ai ${filters.aiReviewed ? "is-active" : ""}`}
                onClick={() => setFilter("aiReviewed")(!filters.aiReviewed)}
              >
                AI已点评
              </button>
              <button
                type="button"
                className={`pl-filter-toggle pl-filter-toggle-expert ${filters.expertReviewed ? "is-active" : ""}`}
                onClick={() => setFilter("expertReviewed")(!filters.expertReviewed)}
              >
                专家已点评
              </button>
            </div>
          </div>

          <p className="small mb-2">
            {visiblePlans.length === plans.length ? `共 ${plans.length} 个课程` : `筛选出 ${visiblePlans.length} / ${plans.length} 个课程`}
            ，已打分 {scored.length} 个
            {average !== null && `，平均分 ${average}`}，待处理 {pending.length} 个（待打分 {scoreCount}，待点评 {reviewCount}）。
            点击行查看各维度打分理由与 AI 点评。设置总分条件时，未打分的课程不在范围内。
          </p>
          <table className="table table-bordered table-sm table-hover">
            <thead className="thead-light">
              <tr>
                {sortableHeader("title", "课程")}
                {sortableHeader("school", "学校 / 教师", "18%")}
                {sortableHeader("completion", "设计完成度", "8%")}
                {sortableHeader("score", "总分", "8%")}
                <th style={{ width: "26%" }}>各维度得分</th>
                <th style={{ width: "15%" }}>打分 / 点评时间</th>
              </tr>
            </thead>
            <tbody>
              {visiblePlans.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-muted small">
                    没有符合筛选条件的课程。
                  </td>
                </tr>
              )}
              {visiblePlans.map((p) => {
                const s = p.score;
                const rv = p.review;
                const isOpen = expanded === p.planId;
                const openable = !!(s || rv);
                const toggle = () => {
                  if (!openable) return;
                  setExpanded(isOpen ? null : p.planId);
                  setExpandedTab(s ? "score" : "review");
                };
                return (
                  <React.Fragment key={p.planId}>
                    <tr style={{ cursor: openable ? "pointer" : "default" }} onClick={toggle}>
                      <td>
                        <Link to={`/plans/${p.planId}`} onClick={(e) => e.stopPropagation()}>
                          {p.title}
                        </Link>
                        <div className="small text-muted">
                          {[p.year && `${p.year}${p.season || ""}`, p.grade, p.theme].filter(Boolean).join(" · ")}
                        </div>
                      </td>
                      <td className="small">
                        {p.schoolName}
                        <div className="text-muted">{p.teacherName}</div>
                      </td>
                      <td>{p.completion.overall}%</td>
                      <td>
                        {s ? <b className={scoreClass(s.totalScore, 100)}>{s.totalScore}</b> : <span className="text-muted small">未打分</span>}
                        {p.needsScore && (
                          <div>
                            <span className="badge badge-primary">待打分</span>
                          </div>
                        )}
                      </td>
                      <td className="small">
                        {s &&
                          s.dimensionScores.map((d) => (
                            <div key={d.name}>
                              {d.name}：<span className={scoreClass(d.score, d.weight)}>{d.score}</span>/{d.weight}
                              {d.level && <span className="text-muted">（{d.level}）</span>}
                            </div>
                          ))}
                      </td>
                      <td className="small">
                        <div>打分：{s ? new Date(s.createdAt).toLocaleString() : "无"}</div>
                        {s && s.outdatedStandard && <span className="badge badge-warning mr-1">旧标准 #{s.standardId}</span>}
                        {s && s.contentChanged && <span className="badge badge-secondary">课程内容已修改</span>}
                        <div className="mt-1">点评：{rv ? new Date(rv.createdAt).toLocaleString() : "无"}</div>
                        {p.needsReview && <span className="badge badge-primary">待点评</span>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} className="bg-light small">
                          <ul className="nav nav-tabs mb-2">
                            {[
                              ["score", "打分理由", !!s],
                              ["review", "AI 点评", !!rv],
                            ].map(([key, label, available]) => (
                              <li className="nav-item" key={key}>
                                <button
                                  type="button"
                                  className={`nav-link btn btn-link btn-sm ${expandedTab === key ? "active" : ""}`}
                                  disabled={!available}
                                  onClick={() => setExpandedTab(key)}
                                >
                                  {label}
                                  {!available && "（无）"}
                                </button>
                              </li>
                            ))}
                          </ul>
                          {expandedTab === "score" && s && (
                            <>
                              {s.summary && <p className="mb-2">{s.summary}</p>}
                              {s.dimensionScores.map((d) => (
                                <div key={d.name} className="mb-1">
                                  <b>
                                    {d.name}（{d.score}/{d.weight}
                                    {d.level && `，${d.level}`}）
                                  </b>
                                  ：{d.rationale}
                                </div>
                              ))}
                              <div className="text-muted mt-2">标准版本 #{s.standardId}</div>
                            </>
                          )}
                          {expandedTab === "review" && rv && (
                            <>
                              <div style={{ whiteSpace: "pre-wrap" }}>{rv.content}</div>
                              <div className="text-muted mt-2">
                                {rv.standardId ? `标准版本 #${rv.standardId}` : "未依据标准"}
                                {` · ${new Date(rv.createdAt).toLocaleString()}`}
                                {rv.contentChanged && " · 课程内容已在点评后修改"}
                              </div>
                            </>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
};

export default AiScoreReview;
