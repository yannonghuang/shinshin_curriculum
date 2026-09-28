import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AiReviewDataService from "../services/ai-review.service";
import AuthService from "../services/auth.service";
import "../curriculum.css";

const POLL_INTERVAL_MS = 3000;
const CRITERIA_DEBOUNCE_MS = 400;

const errorText = (e) => (e.response && e.response.data && e.response.data.message) || e.message;

const formatElapsed = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
};

// Text columns sort A→Z first, numeric ones high→low (see toggleSort).
// Unscored plans always sort last on AI 总分, whichever direction -- same
// rule as ai-scores.component.js.
const TEXT_SORT_KEYS = ["title", "school"];
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
  if (sortKey === "score") {
    if (!a.aiScore && !b.aiScore) return 0;
    if (!a.aiScore) return 1;
    if (!b.aiScore) return -1;
    return dir * (a.aiScore.totalScore - b.aiScore.totalScore);
  }
  return dir * (a.completion.overall - b.completion.overall);
};

const DEFAULT_CRITERIA = { minCompletion: "60", maxCompletion: "", minScore: "", maxScore: "", skipReviewed: true };

// AI -> AI 点评 (admin only). Writes a whole-plan (实施整体点评) AI review,
// judged against the AI 点评标准 in effect, for every submitted plan
// matching the criteria on 完成度 and AI 打分, as a background batch
// (backend services/aiPlanReview.js). Which plans match is
// decided server-side -- the table previews exactly the plans a run would
// review, and the run recomputes the matches with the same criteria.
const AiBulkReview = () => {
  const [criteria, setCriteria] = useState(DEFAULT_CRITERIA);
  const [plans, setPlans] = useState([]);
  const [job, setJob] = useState(null);
  const [standard, setStandard] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState("completion");
  const [sortDir, setSortDir] = useState("desc");
  const allowed = AuthService.isAdmin();

  const refresh = useCallback(
    () =>
      AiReviewDataService.getBulkCandidates(criteria)
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
    [criteria]
  );

  useEffect(() => {
    if (!allowed) return undefined;
    const timer = setTimeout(refresh, CRITERIA_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [allowed, refresh]);

  const running = !!(job && job.running);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!allowed) {
    return <div className="alert alert-warning">批量 AI 点评仅对管理员开放。</div>;
  }

  const matched = plans.filter((p) => p.matched);
  const visiblePlans = [...(showAll ? plans : matched)].sort(compareBy(sortKey, sortDir));

  // Clicking the active column flips it; a new column starts in its
  // natural direction.
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
  const processed = job ? job.done + job.failed : 0;

  const setField = (key) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setCriteria((prev) => ({ ...prev, [key]: value }));
  };

  const run = () => {
    // Each plan is a separate LLM call writing a permanent review, so
    // confirm the count before starting.
    if (!window.confirm(`将为 ${matched.length} 个课程生成 AI 点评（每个课程约需 1 分钟），确定开始吗？`)) return;
    setMessage("");
    AiReviewDataService.runBulkReview(criteria)
      .then((res) => setJob(res.data))
      .catch((e) => setMessage(errorText(e)))
      .then(refresh);
  };

  const numberInput = (key, placeholder, max) => (
    <input
      type="number"
      className="form-control form-control-sm"
      style={{ width: 90 }}
      min={0}
      max={max}
      placeholder={placeholder}
      value={criteria[key]}
      disabled={running}
      onChange={setField(key)}
    />
  );

  return (
    <div className="container">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">AI 点评</h4>
        <button className="btn btn-primary btn-sm" disabled={running || !standard || matched.length === 0} onClick={run}>
          开始 AI 点评（{matched.length} 个课程）
        </button>
      </div>
      <p className="text-muted small">
        为符合以下条件的已提交课程批量生成 AI 点评（实施整体点评，综合课程设计与各课时实施记录），
        {standard ? (
          <>
            依据当前生效的
            <Link to="/ai-review/standard" className="mx-1">AI 点评标准（版本 #{standard.id}）</Link>
            逐维度点评。
          </>
        ) : (
          "依据当前生效的 AI 点评标准逐维度点评。"
        )}
        完成度与
        <Link to="/dashboard" className="mx-1">数据看板</Link>一致，AI 总分取自
        <Link to="/ai-review/scores" className="mx-1">AI 打分</Link>的最新结果。
      </p>

      <div className="card mb-3">
        <div className="card-body py-2">
          <div className="form-inline mb-2">
            <label className="mr-2" style={{ width: 70 }}>完成度</label>
            {numberInput("minCompletion", "不限", 100)}
            <span className="mx-2">% 至</span>
            {numberInput("maxCompletion", "不限", 100)}
            <span className="ml-2">%</span>
          </div>
          <div className="form-inline mb-2">
            <label className="mr-2" style={{ width: 70 }}>AI 总分</label>
            {numberInput("minScore", "不限")}
            <span className="mx-2">至</span>
            {numberInput("maxScore", "不限")}
            <span className="ml-2 small text-muted">设置分数条件时，未打分的课程不在范围内</span>
          </div>
          <div className="form-check">
            <input
              id="bulkSkipReviewed"
              type="checkbox"
              className="form-check-input"
              checked={criteria.skipReviewed}
              disabled={running}
              onChange={setField("skipReviewed")}
            />
            <label className="form-check-label" htmlFor="bulkSkipReviewed">
              跳过已有最新 AI 整体点评的课程（针对当前课程内容、按当前标准）
            </label>
          </div>
        </div>
      </div>

      {loaded && !standard && (
        <div className="alert alert-warning">
          尚未制定 AI 点评标准，请先在 <Link to="/ai-review/standard">AI 点评标准</Link> 中生成。
        </div>
      )}
      {message && <div className="alert alert-danger">{message}</div>}

      {running && (
        <div className="alert alert-info">
          <span className="spinner-border spinner-border-sm mr-2" role="status" />
          正在生成 AI 点评：已完成 {processed} / {job.queued}
          <span className="ml-2 text-muted">已用时 {formatElapsed(now - new Date(job.startedAt).getTime())}</span>
          {job.inProgress && job.inProgress.length > 0 && (
            <div className="small mt-1">
              进行中：{job.inProgress.map((p) => `《${p.title || `课程 #${p.planId}`}》`).join("、")}
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
      {job && !running && job.finishedAt && (
        <div className={`alert ${job.failed ? "alert-warning" : "alert-success"} small`}>
          最近一次批量点评完成于 {new Date(job.finishedAt).toLocaleString()}：
          {job.queued === 0 ? "没有符合条件的课程。" : `新点评 ${job.done} 个${job.failed ? `，失败 ${job.failed} 个` : ""}。`}
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
          <div className="d-flex justify-content-between align-items-center mb-2">
            <span className="small">
              符合条件 {matched.length} / {plans.length} 个已提交课程
            </span>
            <div className="form-check small">
              <input
                id="bulkShowAll"
                type="checkbox"
                className="form-check-input"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              <label className="form-check-label" htmlFor="bulkShowAll">
                显示全部已提交课程
              </label>
            </div>
          </div>
          <table className="table table-bordered table-sm">
            <thead className="thead-light">
              <tr>
                {sortableHeader("title", "课程")}
                {sortableHeader("school", "学校 / 教师", "22%")}
                {sortableHeader("completion", "完成度", "9%")}
                {sortableHeader("score", "AI 总分", "9%")}
                <th style={{ width: "18%" }}>最近 AI 整体点评</th>
              </tr>
            </thead>
            <tbody>
              {visiblePlans.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted small">
                    没有符合条件的课程。
                  </td>
                </tr>
              )}
              {visiblePlans.map((p) => (
                <tr key={p.planId} className={showAll && !p.matched ? "text-muted" : ""}>
                  <td>
                    <Link to={`/plans/${p.planId}`}>{p.title}</Link>
                    {showAll && p.matched && <span className="badge badge-primary ml-2">符合条件</span>}
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
                    {p.aiScore ? (
                      <>
                        {p.aiScore.totalScore}
                        {p.aiScore.outdatedStandard && <div><span className="badge badge-warning">旧标准</span></div>}
                      </>
                    ) : (
                      <span className="text-muted small">未打分</span>
                    )}
                  </td>
                  <td className="small">
                    {p.lastAiReview ? new Date(p.lastAiReview.createdAt).toLocaleString() : <span className="text-muted">无</span>}
                    {p.lastAiReview && p.lastAiReview.outdatedStandard && (
                      <div>
                        <span className="badge badge-warning">
                          {p.lastAiReview.standardId ? `基于旧标准 #${p.lastAiReview.standardId}` : "未依据标准"}
                        </span>
                      </div>
                    )}
                    {p.lastAiReview && p.lastAiReview.contentChanged && (
                      <div>
                        <span className="badge badge-secondary">课程内容已修改</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
};

export default AiBulkReview;
