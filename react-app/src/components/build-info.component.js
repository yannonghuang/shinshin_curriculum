import React, { useEffect, useState } from "react";
import http from "../http-common";
import authHeader from "../services/auth-header";

const REPO_COMMIT_URL = "https://github.com/yannonghuang/shinshin_curriculum/commit/";

// Baked into the bundle at image build time (react-app/Dockerfile's
// REACT_APP_BUILD_* from scripts/deploy-aliyun.sh's build args); empty under
// the dev server.
const FRONTEND = {
  tag: process.env.REACT_APP_BUILD_TAG || null,
  commit: process.env.REACT_APP_BUILD_COMMIT || null,
  commitTime: process.env.REACT_APP_BUILD_COMMIT_TIME || null,
  buildTime: process.env.REACT_APP_BUILD_TIME || null,
};

const fmt = (t) => (t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "—");
const short = (t) =>
  t ? new Date(t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

const CommitLink = ({ commit, tag }) =>
  commit ? (
    <a href={`${REPO_COMMIT_URL}${commit}`} target="_blank" rel="noopener noreferrer">
      {tag || commit.slice(0, 7)}
    </a>
  ) : (
    <span>{tag || "开发环境"}</span>
  );

// Super-only build/deploy footer (rendered by App.js for super users): a
// one-line "构建 <tag> · 部署于 <time>" pinned bottom-left, expanding into
// the full frontend/backend build identity. Frontend and backend are built
// from the same commit by every deploy, so a mismatch means one side didn't
// actually roll out (or the browser is holding a stale bundle) -- flagged.
const BuildInfo = () => {
  const [backend, setBackend] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const load = () =>
    http
      .get("/admin/build-info", { headers: authHeader() })
      .then((res) => {
        setBackend(res.data);
        setError("");
      })
      .catch((e) => setError((e.response && e.response.data && e.response.data.message) || e.message));

  useEffect(() => {
    load();
  }, []);

  const mismatch = backend && FRONTEND.tag && backend.tag && FRONTEND.tag !== backend.tag;
  const tag = (backend && backend.tag) || FRONTEND.tag;

  return (
    <div
      style={{
        position: "fixed",
        left: 8,
        bottom: 8,
        zIndex: 1040,
        fontSize: 12,
        maxWidth: "calc(100vw - 100px)",
      }}
    >
      {open && (
        <div className="card shadow-sm mb-1" style={{ minWidth: 300, background: "#fff" }}>
          <div className="card-body p-2">
            <div className="d-flex justify-content-between mb-1">
              <b>版本信息</b>
              <a href="#!" onClick={(e) => { e.preventDefault(); load(); }}>
                刷新
              </a>
            </div>
            {mismatch && (
              <div className="alert alert-warning py-1 px-2 mb-2">
                前端（{FRONTEND.tag}）与后端（{backend.tag}）版本不一致，请刷新页面或检查部署。
              </div>
            )}
            {error && <div className="text-danger mb-1">后端版本信息获取失败：{error}</div>}
            <table className="table table-sm table-borderless mb-0" style={{ fontSize: 12 }}>
              <tbody>
                <tr>
                  <td className="text-muted pl-0">后端构建</td>
                  <td>{backend ? <CommitLink commit={backend.commit} tag={backend.tag} /> : "—"}</td>
                </tr>
                <tr>
                  <td className="text-muted pl-0">前端构建</td>
                  <td>
                    <CommitLink commit={FRONTEND.commit} tag={FRONTEND.tag} />
                  </td>
                </tr>
                <tr>
                  <td className="text-muted pl-0">提交时间</td>
                  <td>{fmt((backend && backend.commitTime) || FRONTEND.commitTime)}</td>
                </tr>
                <tr>
                  <td className="text-muted pl-0">构建时间</td>
                  <td>{fmt((backend && backend.buildTime) || FRONTEND.buildTime)}</td>
                </tr>
                <tr>
                  <td className="text-muted pl-0">部署（启动）时间</td>
                  <td>{fmt(backend && backend.startedAt)}</td>
                </tr>
                <tr>
                  <td className="text-muted pl-0">最新数据库迁移</td>
                  <td style={{ wordBreak: "break-all" }}>{(backend && backend.latestMigration) || "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
      <button
        type="button"
        className={`btn btn-sm ${mismatch ? "btn-warning" : "btn-light"} border`}
        style={{ fontSize: 12, opacity: open ? 1 : 0.85 }}
        onClick={() => setOpen(!open)}
        title="版本信息（仅超级管理员可见）"
      >
        <i className="fas fa-code-branch mr-1" />
        {tag || "开发环境"}
        {backend && backend.startedAt && ` · 部署于 ${short(backend.startedAt)}`}
        {mismatch && " · 版本不一致"}
      </button>
    </div>
  );
};

export default BuildInfo;
