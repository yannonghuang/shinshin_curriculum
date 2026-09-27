import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// Unscored plans always sort last, whichever direction 总分 is sorted in.
const compareBy = (sortKey, sortDir) => (a, b) => {
  const dir = sortDir === "asc" ? 1 : -1;
  if (sortKey === "title") return dir * (a.title || "").localeCompare(b.title || "", "zh");
  if (!a.score && !b.score) return 0;
  if (!a.score) return 1;
  if (!b.score) return -1;
  return dir * (a.score.totalScore - b.score.totalScore);
};

const errorText = (e) => (e.response && e.response.data && e.response.data.message) || e.message;

const formatElapsed = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
};

const scoreClass =(score, weight) => {
  const ratio = weight ? score / weight : 0;
  if (ratio >= 0.85) return "text-success";
  if (ratio >= 0.6) return "";
  return "text-danger";
};

// AI 点评 -> AI 打分 (expert/admin only). Opening the page triggers a
// background batch scoring every AI-reviewed plan against the AI 点评标准 in
// effect (backend services/aiPlanScoring.js). The batch is incremental --
// plans already scored on that standard with unchanged content are skipped
// -- so revisiting the page only scores what's new or changed. 更新打分
// runs the same incremental batch on demand (e.g. after 重新生成 the
// standard or a plan edit while this page is open); there is no forced
// full re-score, since an unchanged plan under an unchanged standard would
// just get the same score again.
const AiScores = () => {
  const [plans, setPlans] = useState([]);
  const [job, setJob] = useState(null);
  const [standard, setStandard] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(null);
  const triggered = useRef(false);
  const allowed = AuthService.isExpert() || AuthService.isAdmin();

  // Filter + sort state, restored from / kept in sync with the URL -- same
  // pattern as plans-hierarchy.component.js, so returning from a plan (its
  // 返回 is a history.goBack()) lands back on the same filtered, sorted view.
  const history = useHistory();
  const location = useLocation();
  const initialParams = useMemo(() => new URLSearchParams(location.search || ""), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [filterTerm, setFilterTerm] = useState(() => initialParams.get("term") || "");
  const [filterTeacherName, setFilterTeacherName] = useState(() => initialParams.get("teacherName") || "");
  const [filterSchoolName, setFilterSchoolName] = useState(() => initialParams.get("schoolName") || "");
  const [filterTheme, setFilterTheme] = useState(() => initialParams.get("theme") || "");
  const [filterSubmitted, setFilterSubmitted] = useState(() => initialParams.get("submitted") === "1");
  const [filterExpertReviewed, setFilterExpertReviewed] = useState(() => initialParams.get("expertReviewed") === "1");
  const [sortKey, setSortKey] = useState(() => (initialParams.get("sort") === "title" ? "title" : "score"));
  const [sortDir, setSortDir] = useState(() => (initialParams.get("dir") === "asc" ? "asc" : "desc"));
  // "已提交" is admin-only, same as 全部乡土课程 -- experts never see drafts
  // there, so the toggle would be meaningless for them.
  const showSubmittedToggle = AuthService.isAdmin();

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
    setOrDelete("term", filterTerm);
    setOrDelete("teacherName", filterTeacherName);
    setOrDelete("schoolName", filterSchoolName);
    setOrDelete("theme", filterTheme);
    setOrDelete("submitted", filterSubmitted ? "1" : "");
    setOrDelete("expertReviewed", filterExpertReviewed ? "1" : "");
    setOrDelete("sort", sortKey === "score" ? "" : sortKey);
    setOrDelete("dir", sortDir === "desc" ? "" : sortDir);
    const nextSearch = params.toString();
    if (nextSearch !== (location.search || "").replace(/^\?/, "")) {
      history.replace({ pathname: location.pathname, search: nextSearch });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTerm, filterTeacherName, filterSchoolName, filterTheme, filterSubmitted, filterExpertReviewed, sortKey, sortDir]);

  // Only schools/terms that actually have an AI-reviewed plan -- same
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
    const teacherQuery = filterTeacherName.trim().toLowerCase();
    const schoolQuery = filterSchoolName.trim().toLowerCase();
    return plans
      .filter(
        (p) =>
          (!filterTerm || termKey(p) === filterTerm) &&
          (!teacherQuery || (p.teacherName || "").toLowerCase().includes(teacherQuery)) &&
          (!schoolQuery || (p.schoolName || UNASSIGNED_SCHOOL_NAME).toLowerCase().includes(schoolQuery)) &&
          (!filterTheme || p.theme === filterTheme) &&
          (!filterSubmitted || p.status === "submitted") &&
          (!filterExpertReviewed || p.expertReviewed)
      )
      .sort(compareBy(sortKey, sortDir));
  }, [plans, filterTerm, filterTeacherName, filterSchoolName, filterTheme, filterSubmitted, filterExpertReviewed, sortKey, sortDir]);

  // First click on a column sorts it in its natural direction (课程 A→Z,
  // 总分 high→low); clicking the active column again flips it.
  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "title" ? "asc" : "desc");
    }
  };
  const sortIcon = (key) =>
    sortKey !== key ? "fa-sort text-muted" : sortDir === "asc" ? "fa-sort-up" : "fa-sort-down";

  const refresh = useCallback(() => {
    return AiReviewDataService.getScores()
      .then((res) => {
        setPlans(res.data.plans);
        setJob(res.data.job);
        setStandard(res.data.standard);
        setLoaded(true);
      })
      .catch((e) => {
        setLoaded(true);
        setMessage(errorText(e));
      });
  }, []);

  const run = useCallback(
    () => {
      setMessage("");
      return AiReviewDataService.runScoring()
        .then((res) => setJob(res.data))
        .catch((e) => {
          // 422 = no standard yet, already explained by the warning below.
          if (!(e.response && e.response.status === 422)) setMessage(errorText(e));
        })
        .then(refresh);
    },
    [refresh]
  );

  useEffect(() => {
    if (!allowed || triggered.current) return;
    triggered.current = true;
    run();
  }, [allowed, run]);

  const running = !!(job && job.running);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  // Ticks the elapsed-time readout once a second while a batch runs.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!allowed) {
    return <div className="alert alert-warning">AI 点评仅对专家和管理员开放。</div>;
  }

  const processed = job ? job.done + job.failed : 0;
  // Stats follow the filters, so e.g. picking a school shows that school's average.
  const scored = visiblePlans.filter((p) => p.score);
  const average = scored.length
    ? Math.round((scored.reduce((sum, p) => sum + p.score.totalScore, 0) / scored.length) * 10) / 10
    : null;

  return (
    <div className="container">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">AI 打分</h4>
        <button
          className="btn btn-outline-primary btn-sm"
          disabled={running || !standard}
          title="为尚未打分、按旧标准打分或内容已修改的课程打分"
          onClick={() => run()}
        >
          更新打分
        </button>
      </div>

      {standard && (
        <p className="text-muted small">
          按当前生效的
          <Link to="/ai-review/standard" className="mx-1">
            AI 点评标准（版本 #{standard.id}）
          </Link>
          对全部已有 AI 点评的课程打分，满分 {standard.content.totalScore}。已打过分且标准与课程内容均未变化的课程不会重复打分。
        </p>
      )}
      {loaded && !standard && (
        <div className="alert alert-warning">
          尚未制定 AI 点评标准，请先在 <Link to="/ai-review/standard">AI 点评标准</Link> 中生成。
        </div>
      )}

      {message && <div className="alert alert-danger">{message}</div>}

      {running && (
        <div className="alert alert-info">
          <span className="spinner-border spinner-border-sm mr-2" role="status" />
          正在打分：已完成 {processed} / {job.queued}
          {job.skipped > 0 && `（${job.skipped} 个课程已是最新评分，跳过）`}
          <span className="ml-2 text-muted">已用时 {formatElapsed(now - new Date(job.startedAt).getTime())}</span>
          {job.inProgress && job.inProgress.length > 0 && (
            <div className="small mt-1">
              进行中：{job.inProgress.map((p) => `《${p.title || `课程 #${p.planId}`}》`).join("、")}
            </div>
          )}
          <div className="small text-muted">AI 需要通读整个课程并逐维度打分，每个课程约需 1 分钟，请稍候。</div>
          {/* Floor at a sliver + striped animation so a slow first plan
              still reads as "working", not as an empty/stuck bar. */}
          <div className="progress mt-2" style={{ height: 8 }}>
            <div
              className="progress-bar progress-bar-striped progress-bar-animated"
              style={{ width: `${Math.max(job.queued ? (processed / job.queued) * 100 : 100, 5)}%` }}
            />
          </div>
        </div>
      )}
      {job && !running && job.finishedAt && job.queued === 0 && (
        <div className="alert alert-success small">
          全部 {job.total} 个课程均已按当前标准（版本 #{job.standardId}）打分，且课程内容未修改，无需重新打分。
        </div>
      )}
      {job && !running && job.finishedAt && job.queued > 0 && (
        <div className={`alert ${job.failed ? "alert-warning" : "alert-success"} small`}>
          最近一次打分完成于 {new Date(job.finishedAt).toLocaleString()}：新打分 {job.done} 个
          {job.skipped > 0 && `，跳过 ${job.skipped} 个（已是最新）`}
          {job.failed > 0 && `，失败 ${job.failed} 个`}。
          {job.errors.map((e) => (
            <div key={e.planId}>
              《{e.title || `课程 #${e.planId}`}》：{e.message}
            </div>
          ))}
        </div>
      )}

      {loaded && plans.length === 0 && <p className="text-muted">暂无已有 AI 点评的课程。</p>}

      {plans.length > 0 && (
        <>
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
              <label htmlFor="aiScoresSchoolFilter">学校名称筛选</label>
              <Select
                inputId="aiScoresSchoolFilter"
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
          <div className="pl-filter-bar mb-3">
            {showSubmittedToggle && (
              <button
                type="button"
                className={`pl-filter-toggle ${filterSubmitted ? "is-active" : ""}`}
                onClick={() => setFilterSubmitted((prev) => !prev)}
              >
                已提交
              </button>
            )}
            <button
              type="button"
              className={`pl-filter-toggle pl-filter-toggle-expert ${filterExpertReviewed ? "is-active" : ""}`}
              onClick={() => setFilterExpertReviewed((prev) => !prev)}
            >
              专家已点评
            </button>
          </div>

          <p className="small mb-2">
            {visiblePlans.length === plans.length ? `共 ${plans.length} 个课程` : `筛选出 ${visiblePlans.length} / ${plans.length} 个课程`}
            ，已打分 {scored.length} 个
            {average !== null && `，平均分 ${average}`}。点击行查看各维度打分理由。
          </p>
          <table className="table table-bordered table-sm table-hover">
            <thead className="thead-light">
              <tr>
                <th style={{ cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => toggleSort("title")}>
                  课程 <i className={`fas ${sortIcon("title")} ml-1`} />
                </th>
                <th style={{ width: "22%" }}>学校 / 教师</th>
                <th style={{ width: "8%", cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => toggleSort("score")}>
                  总分 <i className={`fas ${sortIcon("score")} ml-1`} />
                </th>
                <th style={{ width: "28%" }}>各维度得分</th>
                <th style={{ width: "14%" }}>打分时间</th>
              </tr>
            </thead>
            <tbody>
              {visiblePlans.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted small">
                    没有符合筛选条件的课程。
                  </td>
                </tr>
              )}
              {visiblePlans.map((p) => {
                const s = p.score;
                const isOpen = expanded === p.planId;
                return (
                  <React.Fragment key={p.planId}>
                    <tr style={{ cursor: s ? "pointer" : "default" }} onClick={() => s && setExpanded(isOpen ? null : p.planId)}>
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
                      <td>
                        {s ? <b className={scoreClass(s.totalScore, 100)}>{s.totalScore}</b> : <span className="text-muted small">未打分</span>}
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
                        {s && new Date(s.createdAt).toLocaleString()}
                        {s && standard && Number(s.standardId) !== Number(standard.id) && (
                          <div>
                            <span className="badge badge-warning">基于旧标准 #{s.standardId}</span>
                          </div>
                        )}
                        {s && s.contentChanged && (
                          <div>
                            <span className="badge badge-secondary">课程内容已修改</span>
                          </div>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={5} className="bg-light small">
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
                          <div className="text-muted mt-2">
                            标准版本 #{s.standardId}
                            {s.aiModel && ` · ${s.aiModel}`}
                          </div>
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

export default AiScores;
