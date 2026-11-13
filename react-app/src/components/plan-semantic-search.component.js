import React, { useState } from "react";
import { Link } from "react-router-dom";
import PlanDataService from "../services/plan.service";
import { tr } from "../i18n";

// 全部乡土课程's 语义搜索 (experts and admins): a question in plain words,
// ranked by the backend's local vector index (services/planSearch.js) --
// no AI call. The explanation line says what the plans were compared
// against, since a 「…较好…」 ranking measures whether a field is about the
// right thing, not how well it is written.
const EXAMPLES = ["请找出5个设置社会情感目标较好的项目", "哪些项目让学生采访了村里的老人？"];

const explain = (result) => {
  const fields = result.fields && result.fields.length ? result.fields.join("、") : null;
  if (result.mode === "definition") {
    return tr("按{basis}比对各课程该栏的内容，并压低与「{contrast}」相近的内容。排序反映目标是否属于该类别，不评价写得是否具体、可观察。", {
      basis: result.basis,
      contrast: result.contrast || "",
    });
  }
  if (result.mode === "library") {
    return tr("以{basis}为参照比对各课程内容{scope}。排序反映内容是否切题，不评价写得好坏。", {
      basis: result.basis,
      scope: fields ? tr("（范围：{fields}）", { fields }) : "",
    });
  }
  return tr("按问题的意思查找课程内容，不限于字面相同{scope}。", { scope: fields ? tr("（范围：{fields}）", { fields }) : "" });
};

const PlanSemanticSearch = () => {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const run = async (q) => {
    const text = q.trim();
    if (!text) return;
    setQuery(text);
    setLoading(true);
    setError("");
    try {
      const resp = await PlanDataService.semanticSearch(text);
      setResult(resp.data);
    } catch (err) {
      setResult(null);
      setError(err?.response?.data?.message || tr("语义搜索失败。"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pl-semantic-search mb-3">
      <label htmlFor="planSemanticSearch">{tr("语义搜索")}</label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <div className="input-group">
          <input
            id="planSemanticSearch"
            className="form-control"
            placeholder={tr("用一句话描述要找的课程，例如：请找出5个设置社会情感目标较好的项目")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={300}
          />
          <div className="input-group-append">
            <button type="submit" className="btn btn-primary" disabled={loading || !query.trim()}>
              {loading ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-search"></i>} {tr("搜索")}
            </button>
          </div>
        </div>
      </form>
      {!result && !error && (
        <div className="pl-semantic-examples">
          {tr("试试：")}
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="btn btn-link btn-sm p-0 ml-2" onClick={() => run(ex)} disabled={loading}>
              {ex}
            </button>
          ))}
        </div>
      )}
      {error && <div className="alert alert-warning py-2 mt-2">{error}</div>}
      {result && (
        <div className="pl-semantic-results">
          <div className="pl-semantic-head">
            <span>
              {result.mode ? explain(result) : null}
              {result.index && result.index.syncing && (
                <span className="ml-1">{tr("（索引更新中 {progress}，部分课程可能暂未纳入）", { progress: result.index.progress || "" })}</span>
              )}
            </span>
            <button type="button" className="close ml-2" aria-label={tr("关闭")} onClick={() => setResult(null)}>
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
          {result.results.length === 0 ? (
            <div className="pl-empty">
              {result.index && result.index.parts === 0 ? tr("搜索索引尚未建立，请稍后再试。") : tr("没有找到相关的课程内容。")}
            </div>
          ) : (
            <ol className="pl-semantic-list">
              {result.results.map((r) => (
                <li key={r.planId}>
                  <div>
                    <Link to={`/plans/${r.planId}`}>{r.title}</Link>
                    <span className="pl-semantic-meta">
                      {[r.teacherName, r.schoolName, r.year ? `${r.year} ${r.season ? tr(r.season) : ""}`.trim() : "", r.status === "draft" ? tr("草稿") : ""]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="pl-semantic-score" title={tr("相对得分，仅用于本次排序")}>
                      {r.score.toFixed(3)}
                    </span>
                  </div>
                  <div className="pl-semantic-snippet">
                    <span className="pl-semantic-field">{r.label}</span>
                    {r.snippet}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
};

export default PlanSemanticSearch;
