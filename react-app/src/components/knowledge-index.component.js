import React, { useCallback, useEffect, useState } from "react";
import MaterialTopicDataService from "../services/material-topic.service";

const POLL_INTERVAL_MS = 3000;

const KIND_BADGE = {
  rubric: "badge-danger",
  case: "badge-info",
  method: "badge-primary",
  concept: "badge-success",
  data: "badge-secondary",
  other: "badge-light",
};

const SOURCE_TYPE_LABEL = { material_artifact: "文件", material_link: "链接", material_topic_meta: "基本信息" };

const chunkLocator = (c) =>
  c.pageFrom ? (c.pageFrom === c.pageTo ? `第 ${c.pageFrom} 页` : `第 ${c.pageFrom}–${c.pageTo} 页`) : null;

// The lower two layers of a topic's knowledge tree (backend
// services/knowledgeTree.js), shown under its 知识卡片 (the top layer):
//   资料索引 -- each source's summary + "contents" inventory, what AI 点评 /
//              欣欣小助手 / AI 点评标准 route on when picking relevant material;
//   原文     -- the verbatim, page-cited text an inventory item (or a whole
//              source) points at, loaded on demand.
// Read-only, apart from admins' 重建资料索引 (re-extract + re-summarize every
// source under the topic, in the background).
const KnowledgeIndex = ({ topicId, isAdmin }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [openKey, setOpenKey] = useState(null); // which item/source's verbatim text is expanded
  const [verbatim, setVerbatim] = useState({}); // key -> chunks
  const [collapsed, setCollapsed] = useState({}); // source key -> hide its inventory

  const load = useCallback((opts) => {
    return MaterialTopicDataService.getKnowledgeTree(topicId, opts)
      .then((res) => {
        setData(res.data);
        setError("");
      })
      .catch((e) => setError((e.response && e.response.data && e.response.data.message) || "加载资料索引失败。"));
  }, [topicId]);

  useEffect(() => {
    setData(null);
    setOpenKey(null);
    setVerbatim({});
    load();
  }, [load]);

  const rebuilding = !!(data && data.rebuilding);
  useEffect(() => {
    if (!rebuilding) return undefined;
    const timer = setInterval(() => load({ background: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [rebuilding, load]);

  const toggleVerbatim = (key, source, from, to) => {
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(key);
    if (verbatim[key]) return;
    MaterialTopicDataService.getKnowledgeChunks(topicId, { sourceType: source.sourceType, sourceId: source.sourceId, from, to })
      .then((res) => setVerbatim((prev) => ({ ...prev, [key]: res.data })))
      .catch(() => setVerbatim((prev) => ({ ...prev, [key]: [] })));
  };

  const rebuild = () => {
    if (!window.confirm("将重新提取并索引此主题下的全部资料（每份资料约需数十秒），期间 AI 功能仍使用旧索引。确定继续吗？")) return;
    MaterialTopicDataService.rebuildKnowledgeTree(topicId)
      .then(load)
      .catch((e) => setError((e.response && e.response.data && e.response.data.message) || "重建资料索引失败。"));
  };

  const renderVerbatim = (key) => {
    if (openKey !== key) return null;
    const chunks = verbatim[key];
    if (!chunks) return <div className="small text-muted my-2">加载原文中…</div>;
    if (chunks.length === 0) return <div className="small text-muted my-2">暂无原文。</div>;
    return (
      <div className="border rounded bg-light p-2 my-2" style={{ maxHeight: 360, overflowY: "auto" }}>
        {chunks.map((c) => (
          <div key={c.chunkIndex} className="mb-2">
            {chunkLocator(c) && <div className="small text-muted">{chunkLocator(c)}</div>}
            <div className="small" style={{ whiteSpace: "pre-wrap" }}>
              {c.content}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const kindLabels = (data && data.kindLabels) || {};

  return (
    <div className="pl-card mt-3">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <h6 className="mb-0">资料索引</h6>
        {isAdmin && (
          <button type="button" className="btn btn-outline-secondary btn-sm" disabled={rebuilding} onClick={rebuild}>
            {rebuilding ? "重建中…" : "重建资料索引"}
          </button>
        )}
      </div>
      <p className="small text-muted">
        知识库按三层组织：上方的<b>主题知识卡片</b>概括整个主题；下面是每份资料的<b>摘要与内容条目</b>；点击条目可查看对应的
        <b>原文</b>（注明页码）。AI 点评、AI 点评标准与欣欣小助手按这些摘要与条目找到相关资料，并对每段原文做语义匹配，再引用其原文。
      </p>

      {rebuilding && (
        <div className="alert alert-info py-2 small">
          <span className="spinner-border spinner-border-sm mr-2" role="status" />
          正在重建此主题的资料索引…
        </div>
      )}
      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {!data && !error && <div className="pl-empty">加载中...</div>}
      {data && data.sources.length === 0 && <div className="small text-muted">此主题下暂无已索引的资料。</div>}

      {data &&
        data.sources.map((s) => {
          const key = `${s.sourceType}:${s.sourceId}`;
          const isCollapsed = collapsed[key];
          return (
            <div key={key} className="border rounded p-2 mb-2">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <span className="badge badge-light border mr-2">{SOURCE_TYPE_LABEL[s.sourceType]}</span>
                  <b>{s.title || `${SOURCE_TYPE_LABEL[s.sourceType]} #${s.sourceId}`}</b>
                  <span className="small text-muted ml-2">
                    {s.locator && `${s.locator} · `}
                    {s.charCount} 字
                    {s.embeddedCount < s.chunkCount && ` · 语义索引 ${s.embeddedCount}/${s.chunkCount} 段`}
                  </span>
                </div>
                <div className="text-nowrap">
                  <button type="button" className="btn btn-link btn-sm p-0 mr-2" onClick={() => toggleVerbatim(`${key}:all`, s)}>
                    {openKey === `${key}:all` ? "收起原文" : "全文"}
                  </button>
                  {s.contents.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0"
                      onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
                    >
                      {isCollapsed ? `展开条目（${s.contents.length}）` : "收起条目"}
                    </button>
                  )}
                </div>
              </div>
              {s.summary ? (
                <div className="small mt-1">{s.summary}</div>
              ) : (
                <div className="small text-muted mt-1">尚未生成摘要{isAdmin ? "，可点击「重建资料索引」生成。" : "。"}</div>
              )}
              {renderVerbatim(`${key}:all`)}

              {!isCollapsed && s.contents.length > 0 && (
                <ul className="list-unstyled mb-0 mt-2">
                  {s.contents.map((it, i) => {
                    const itemKey = `${key}:${i}`;
                    return (
                      <li key={itemKey} className="small mb-1">
                        <button
                          type="button"
                          className="btn btn-link btn-sm p-0 text-left"
                          style={{ fontSize: "inherit" }}
                          onClick={() => toggleVerbatim(itemKey, s, it.chunkFrom, it.chunkTo)}
                        >
                          <span className={`badge ${KIND_BADGE[it.kind] || "badge-light"} mr-2`}>{kindLabels[it.kind] || it.kind}</span>
                          {it.label}
                          {it.locator && <span className="text-muted ml-1">（{it.locator}）</span>}
                        </button>
                        {renderVerbatim(itemKey)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
    </div>
  );
};

export default KnowledgeIndex;
