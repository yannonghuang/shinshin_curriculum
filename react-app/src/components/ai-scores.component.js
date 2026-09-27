import React, { useCallback, useEffect, useRef, useState } from "react";
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
// -- so revisiting the page only scores what's new or changed; 全部重新打分
// forces every plan to be rescored.
const AiScores = () => {
  const [plans, setPlans] = useState([]);
  const [job, setJob] = useState(null);
  const [standard, setStandard] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(null);
  const triggered = useRef(false);
  const allowed = AuthService.isExpert() || AuthService.isAdmin();

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
    (force) => {
      setMessage("");
      return AiReviewDataService.runScoring(force)
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
    run(false);
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
  const scored = plans.filter((p) => p.score);
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
          onClick={() => {
            if (window.confirm("将按当前生效的 AI 点评标准，对全部已有 AI 点评的课程重新打分（包括已打过分的课程）。确定继续吗？")) {
              run(true);
            }
          }}
        >
          全部重新打分
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
      {job && !running && job.finishedAt && (
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
          <p className="small mb-2">
            共 {plans.length} 个课程，已打分 {scored.length} 个
            {average !== null && `，平均分 ${average}`}。点击行查看各维度打分理由。
          </p>
          <table className="table table-bordered table-sm table-hover">
            <thead className="thead-light">
              <tr>
                <th>课程</th>
                <th style={{ width: "22%" }}>学校 / 教师</th>
                <th style={{ width: "8%" }}>总分</th>
                <th style={{ width: "28%" }}>各维度得分</th>
                <th style={{ width: "14%" }}>打分时间</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => {
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
