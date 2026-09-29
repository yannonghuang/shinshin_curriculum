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

const STEP_LABELS = { combined: "打分加点评中", score: "打分中", review: "点评中" };

// Same sortable columns and rules as ai-bulk-review.component.js: text
// columns sort A→Z first, numeric ones high→low (see toggleSort); unscored
// plans always sort last on AI 总分, whichever direction.
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

// Same filters and defaults as AI 点评 (ai-bulk-review.component.js), minus
// its 跳过已有最新点评 -- this page already only runs what's missing.
const DEFAULT_CRITERIA = { minCompletion: "60", maxCompletion: "", minScore: "", maxScore: "" };

// AI -> AI打分加点评 (super only). One background batch (backend
// services/aiScoreAndReview.js) bringing every submitted plan up to date on
// both AI 打分 and whole-plan AI 点评. Every plan costs a single LLM turn
// (the token-economics point of this page) asking for just what it's
// missing -- score and review together, or only one -- with the
// 目标一致性与完整性核查 done in that same turn. Plans can be narrowed by the
// same 完成度/AI 总分 filters as AI 点评; which plans match is decided
// server-side, so the table previews exactly what a run would do.
const AiScoreReview = () => {
  const [criteria, setCriteria] = useState(DEFAULT_CRITERIA);
  const [sortKey, setSortKey] = useState("completion");
  const [sortDir, setSortDir] = useState("desc");
  const [plans, setPlans] = useState([]);
  const [job, setJob] = useState(null);
  const [standard, setStandard] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [showAll, setShowAll] = useState(false);
  const allowed = AuthService.isSuper();

  const refresh = useCallback(
    () =>
      AiReviewDataService.getScoreReviewCandidates(criteria)
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
    return <div className="alert alert-warning">AI打分加点评仅对超级管理员开放。</div>;
  }

  const matched = plans.filter((p) => p.matched);
  const scoreCount = matched.filter((p) => p.needsScore).length;
  const combinedCount = matched.filter((p) => p.needsScore && p.needsReview).length;
  const reviewCount = matched.filter((p) => p.needsReview).length;
  const visiblePlans = [...(showAll ? plans : matched)].sort(compareBy(sortKey, sortDir));
  const processed = job ? job.done + job.failed : 0;

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

  const setField = (key) => (e) => {
    const { value } = e.target;
    setCriteria((prev) => ({ ...prev, [key]: value }));
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

  const run = () => {
    // Each step is a separate LLM call and each review is permanent, so
    // confirm the counts before starting.
    if (
      !window.confirm(
        `将为 ${matched.length} 个课程处理：其中 ${combinedCount} 个同时打分加点评，${scoreCount - combinedCount} 个仅打分，${
          reviewCount - combinedCount
        } 个仅点评（每个课程一次 AI 调用，约需 1-2 分钟），确定开始吗？`
      )
    )
      return;
    setMessage("");
    AiReviewDataService.runScoreReview(criteria)
      .then((res) => setJob(res.data))
      .catch((e) => setMessage(errorText(e)))
      .then(refresh);
  };

  return (
    <div className="container">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">AI打分加点评</h4>
        <button className="btn btn-primary btn-sm" disabled={running || !standard || matched.length === 0} onClick={run}>
          开始（{matched.length} 个课程）
        </button>
      </div>
      <p className="text-muted small">
        为符合以下条件的已提交课程补齐 AI 打分与 AI 实施整体点评（针对当前课程内容、按当前标准）：每个课程只需一次 AI
        调用，只补齐所缺的部分——两者都缺的同时完成打分与点评，二者保持一致。打分与点评都会核查课程的
        目标一致性与完整性（WHY·学习目标 与各课时教学目标是否一一对应）。
        {standard && (
          <>
            依据当前生效的
            <Link to="/ai-review/standard" className="mx-1">AI 点评标准（版本 #{standard.id}）</Link>。
          </>
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
          <div className="form-inline">
            <label className="mr-2" style={{ width: 70 }}>AI 总分</label>
            {numberInput("minScore", "不限")}
            <span className="mx-2">至</span>
            {numberInput("maxScore", "不限")}
            <span className="ml-2 small text-muted">设置分数条件时，未打分的课程不在范围内</span>
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
      {job && !running && job.finishedAt && (
        <div className={`alert ${job.failed ? "alert-warning" : "alert-success"} small`}>
          最近一次运行完成于 {new Date(job.finishedAt).toLocaleString()}：
          {job.queued === 0
            ? "没有符合条件、需要处理的课程。"
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
          <div className="d-flex justify-content-between align-items-center mb-2">
            <span className="small">
              符合条件 {matched.length} / {plans.length} 个已提交课程（待打分 {scoreCount}，待点评 {reviewCount}）
            </span>
            <div className="form-check small">
              <input
                id="scoreReviewShowAll"
                type="checkbox"
                className="form-check-input"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              <label className="form-check-label" htmlFor="scoreReviewShowAll">
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
                {sortableHeader("score", "AI 总分", "12%")}
                <th style={{ width: "18%" }}>最近 AI 整体点评</th>
              </tr>
            </thead>
            <tbody>
              {visiblePlans.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted small">
                    没有符合条件、需要处理的课程。
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
                    {p.aiScore ? p.aiScore.totalScore : <span className="text-muted small">未打分</span>}
                    {p.aiScore && p.aiScore.outdatedStandard && (
                      <div>
                        <span className="badge badge-warning">旧标准</span>
                      </div>
                    )}
                    {p.needsScore && (
                      <div>
                        <span className="badge badge-primary">待打分</span>
                      </div>
                    )}
                  </td>
                  <td className="small">
                    {p.lastAiReview ? new Date(p.lastAiReview.createdAt).toLocaleString() : <span className="text-muted">无</span>}
                    {p.needsReview && (
                      <div>
                        <span className="badge badge-primary">待点评</span>
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

export default AiScoreReview;
