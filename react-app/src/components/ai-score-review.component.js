import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AiReviewDataService from "../services/ai-review.service";
import AuthService from "../services/auth.service";
import "../curriculum.css";

const POLL_INTERVAL_MS = 3000;

const errorText = (e) => (e.response && e.response.data && e.response.data.message) || e.message;

const formatElapsed = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
};

const STEP_LABELS = { combined: "打分加点评中", score: "打分中", review: "点评中" };

// AI -> AI打分加点评 (super only). One background batch (backend
// services/aiScoreAndReview.js) bringing every submitted plan up to date on
// both AI 打分 and whole-plan AI 点评: a plan missing both gets a single LLM
// turn producing the score and the review together (the token-economics
// point of this page); one missing only one half gets just that half. The
// 目标一致性与完整性核查 applies to both either way. The table previews
// exactly what a run would do.
const AiScoreReview = () => {
  const [plans, setPlans] = useState([]);
  const [job, setJob] = useState(null);
  const [standard, setStandard] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [showAll, setShowAll] = useState(false);
  const allowed = AuthService.isSuper();

  const refresh = useCallback(
    () =>
      AiReviewDataService.getScoreReviewCandidates()
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

  const pending = plans.filter((p) => p.needsScore || p.needsReview);
  const scoreCount = pending.filter((p) => p.needsScore).length;
  const combinedCount = pending.filter((p) => p.needsScore && p.needsReview).length;
  const reviewCount = pending.filter((p) => p.needsReview).length;
  const visiblePlans = showAll ? plans : pending;
  const processed = job ? job.done + job.failed : 0;

  const run = () => {
    // Each step is a separate LLM call and each review is permanent, so
    // confirm the counts before starting.
    if (
      !window.confirm(
        `将为 ${pending.length} 个课程处理：其中 ${combinedCount} 个一次完成打分加点评，${scoreCount - combinedCount} 个仅打分，${
          reviewCount - combinedCount
        } 个仅点评（每个课程约需 1-2 分钟），确定开始吗？`
      )
    )
      return;
    setMessage("");
    AiReviewDataService.runScoreReview()
      .then((res) => setJob(res.data))
      .catch((e) => setMessage(errorText(e)))
      .then(refresh);
  };

  return (
    <div className="container">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">AI打分加点评</h4>
        <button className="btn btn-primary btn-sm" disabled={running || !standard || pending.length === 0} onClick={run}>
          开始（{pending.length} 个课程）
        </button>
      </div>
      <p className="text-muted small">
        为所有已提交课程补齐 AI 打分与 AI 整体点评（针对当前课程内容、按当前标准）：两者都缺的课程在一次 AI
        调用中同时完成打分与点评，节省用量且二者保持一致；只缺其一的课程仅补齐所缺的一项。打分与点评都会核查课程的
        目标一致性与完整性（WHY·学习目标 与各课时教学目标是否一一对应）。
        {standard && (
          <>
            依据当前生效的
            <Link to="/ai-review/standard" className="mx-1">AI 点评标准（版本 #{standard.id}）</Link>。
          </>
        )}
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
      {job && !running && job.finishedAt && (
        <div className={`alert ${job.failed ? "alert-warning" : "alert-success"} small`}>
          最近一次运行完成于 {new Date(job.finishedAt).toLocaleString()}：
          {job.queued === 0
            ? "所有课程均已有最新打分与点评。"
            : `新打分 ${job.scored} 个，新点评 ${job.reviewed} 个（其中 ${job.combined} 个一次完成）${
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
              待处理 {pending.length} / {plans.length} 个已提交课程（待打分 {scoreCount}，待点评 {reviewCount}）
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
                <th>课程</th>
                <th style={{ width: "22%" }}>学校 / 教师</th>
                <th style={{ width: "9%" }}>完成度</th>
                <th style={{ width: "12%" }}>AI 总分</th>
                <th style={{ width: "18%" }}>最近 AI 整体点评</th>
              </tr>
            </thead>
            <tbody>
              {visiblePlans.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted small">
                    所有课程均已有最新打分与点评。
                  </td>
                </tr>
              )}
              {visiblePlans.map((p) => (
                <tr key={p.planId} className={showAll && !p.needsScore && !p.needsReview ? "text-muted" : ""}>
                  <td>
                    <Link to={`/plans/${p.planId}`}>{p.title}</Link>
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
