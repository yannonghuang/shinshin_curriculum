import React, { useEffect, useState } from "react";
import PlanDataService from "../services/plan.service";
import { tr } from "../i18n";

// 全部乡土课程's 语义搜索 (experts and admins) -- a filter like the others on
// that page: the question goes to the backend's local vector index
// (services/planSearch.js, no AI call), and the hits narrow the page's own
// tree and cards (plans-hierarchy.component.js, via onResult), each card
// showing its rank and the matching excerpt. The line under the box says
// what the plans were compared against, since a 「…较好…」 ranking measures
// whether a field is about the right thing, not how well it is written.
const EXAMPLES = ["请找出5个设置社会情感目标较好的项目", "哪些项目让学生采访了村里的老人？"];

const explain = (result) => {
  const fields = result.fields && result.fields.length ? result.fields.join("、") : null;
  const scope = fields ? tr("（范围：{fields}）", { fields }) : "";
  if (result.mode === "definition") {
    return tr("按{basis}比对各课程该栏的内容，并压低与「{contrast}」相近的内容。排序反映目标是否属于该类别，不评价写得是否具体、可观察。", {
      basis: result.basis,
      contrast: result.contrast || "",
    });
  }
  if (result.mode === "library") {
    return tr("以{basis}为参照比对各课程内容{scope}。排序反映内容是否切题，不评价写得好坏。", { basis: result.basis, scope });
  }
  return tr("按问题的意思查找课程内容，不限于字面相同{scope}。", { scope });
};

const PlanSemanticSearch = ({ initialQuery, onResult }) => {
  const [query, setQuery] = useState(initialQuery || "");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const apply = (next, q) => {
    setResult(next);
    onResult(next ? { query: q, result: next } : null);
  };

  const run = async (q) => {
    const text = (q || "").trim();
    if (!text) return;
    setQuery(text);
    setLoading(true);
    setError("");
    try {
      const resp = await PlanDataService.semanticSearch(text);
      apply(resp.data, text);
    } catch (err) {
      apply(null);
      setError(err?.response?.data?.message || tr("语义搜索失败。"));
    } finally {
      setLoading(false);
    }
  };

  // A query restored from the URL (返回 from a plan) re-runs once.
  useEffect(() => {
    if (initialQuery) run(initialQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = () => {
    setQuery("");
    setError("");
    apply(null);
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
            {(result || query) && (
              <button type="button" className="btn btn-outline-secondary" onClick={clear} title={tr("清除语义搜索")}>
                <i className="fas fa-times"></i>
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={loading || !query.trim()}>
              {loading ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-search"></i>} {tr("搜索")}
            </button>
          </div>
        </div>
      </form>
      {!result && !error && !loading && (
        <div className="pl-semantic-examples">
          {tr("试试：")}
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="btn btn-link btn-sm p-0 ml-2" onClick={() => run(ex)}>
              {ex}
            </button>
          ))}
        </div>
      )}
      {error && <div className="alert alert-warning py-2 mt-2">{error}</div>}
      {result && (
        <div className="pl-semantic-examples">
          {result.results.length === 0
            ? result.index && result.index.parts === 0
              ? tr("搜索索引尚未建立，请稍后再试。")
              : tr("没有找到相关的课程内容。")
            : tr("按相关度取前 {n} 项，课程卡片上标有名次与匹配内容。", { n: result.results.length })}{" "}
          {result.mode ? explain(result) : null}
          {result.index && result.index.syncing && tr("（索引更新中 {progress}，部分课程可能暂未纳入）", { progress: result.index.progress || "" })}
        </div>
      )}
    </div>
  );
};

export default PlanSemanticSearch;
