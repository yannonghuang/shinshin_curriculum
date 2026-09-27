import React, { useCallback, useEffect, useRef, useState } from "react";
import { Prompt } from "react-router-dom";
import AiReviewDataService from "../services/ai-review.service";
import AuthService from "../services/auth.service";
import { consumeSkipUnsavedWarning } from "../utils/unsavedChangesGuard";
import "../curriculum.css";

const POLL_INTERVAL_MS = 3000;
const DEFAULT_LEVELS = ["优秀", "良好", "合格", "待改进"];

const errorText = (e) => (e.response && e.response.data && e.response.data.message) || e.message;
const clone = (o) => JSON.parse(JSON.stringify(o));
const lines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean);

const SEVERITY_CLASS = { error: "danger", high: "danger", warning: "warning", medium: "warning", low: "secondary" };
const SEVERITY_LABEL = { error: "错误", warning: "注意", high: "高", medium: "中", low: "低" };

const cautionCount = (cautions) =>
  cautions ? cautions.structural.length + (cautions.ai ? cautions.ai.items.length : 0) : 0;

// Structural (deterministic) issues plus the AI's "超出资料依据" cautions for
// one human override -- shown live while editing, and again read-only on a
// saved human version as the record of what its operator chose to accept.
const CautionsPanel = ({ cautions }) => {
  if (!cautions) return null;
  const { structural, ai } = cautions;
  if (cautionCount(cautions) === 0) {
    return (
      <div className="alert alert-success mb-2">
        {ai && ai.summary ? `AI 核查：${ai.summary}` : "未发现问题。"}
      </div>
    );
  }
  return (
    <div className="mb-2">
      {structural.length > 0 && (
        <div className="mb-2">
          <b>结构核查</b>
          {structural.map((c, i) => (
            <div key={i} className={`alert alert-${SEVERITY_CLASS[c.level]} py-1 px-2 mb-1 small`}>
              <span className="badge badge-light mr-2">{SEVERITY_LABEL[c.level]}</span>
              {c.dimension && <b className="mr-1">{c.dimension}：</b>}
              {c.message}
            </div>
          ))}
        </div>
      )}
      {ai && (
        <div>
          <b>AI 核查（对照学习资源库）</b>
          {ai.summary && <div className="small text-muted mb-1">{ai.summary}</div>}
          {ai.items.map((c, i) => (
            <div key={i} className={`alert alert-${SEVERITY_CLASS[c.severity]} py-1 px-2 mb-1 small`}>
              <span className="badge badge-light mr-2">风险 {SEVERITY_LABEL[c.severity]}</span>
              {c.dimension && <b className="mr-1">{c.dimension}：</b>}
              {c.change && <div className="text-muted">变化：{c.change}</div>}
              <div>{c.message}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Which 学习资源库 material an AI-generated version was built from (backend
// knowledgeTree.js#buildContext provenance): evaluation standards found in
// the library and quoted verbatim, other material quoted verbatim, material
// used only as a summary, and topics used only as background.
const RetrievalSources = ({ retrieval }) => {
  if (!retrieval) return null;
  const where = (x) => `《${x.title}》${x.locator ? `（${x.locator}）` : ""}`;
  const semantic = retrieval.semantic || [];
  const count =
    retrieval.anchors.length + retrieval.verbatim.length + semantic.length + retrieval.summarized.length + retrieval.background.length;
  return (
    <details className="mb-3">
      <summary className="small text-muted">
        依据资料（资料中已有的评价标准 {retrieval.anchors.length} 份，共引用 {count} 项）
      </summary>
      <div className="small mt-2">
        {retrieval.anchors.length > 0 && (
          <div className="mb-2">
            <b>资料中已有的评价标准（原文引用，作为标准骨架）</b>
            <ul className="mb-0">
              {retrieval.anchors.map((a, i) => (
                <li key={i}>
                  {where(a)}：{a.label}
                  <span className="text-muted"> · {a.topic}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {retrieval.verbatim.length > 0 && (
          <div className="mb-2">
            <b>原文引用</b>
            <ul className="mb-0">
              {retrieval.verbatim.map((v, i) => (
                <li key={i}>
                  {where(v)}
                  {v.label && `：${v.label}`}
                  <span className="text-muted"> · {v.topic}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {semantic.length > 0 && (
          <div className="mb-2">
            <b>语义匹配片段（原文引用）</b>
            <ul className="mb-0">
              {semantic.map((v, i) => (
                <li key={i}>
                  {where(v)}
                  <span className="text-muted">
                    {" "}
                    · {v.topic} · 相似度 {v.score}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {retrieval.summarized.length > 0 && (
          <div className="mb-2">
            <b>摘要引用</b>
            <ul className="mb-0">
              {retrieval.summarized.map((v, i) => (
                <li key={i}>
                  《{v.title}》<span className="text-muted"> · {v.topic}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {retrieval.background.length > 0 && (
          <div>
            <b>背景主题</b>：{retrieval.background.join("、")}
          </div>
        )}
      </div>
    </details>
  );
};

const StandardTable = ({ content }) => (
  <>
    {content.overview && <p>{content.overview}</p>}
    <table className="table table-bordered table-sm">
      <thead className="thead-light">
        <tr>
          <th style={{ width: "18%" }}>评分维度</th>
          <th style={{ width: "8%" }}>分值</th>
          <th>评分要点</th>
          <th style={{ width: "34%" }}>等级描述</th>
        </tr>
      </thead>
      <tbody>
        {content.dimensions.map((d, i) => (
          <tr key={i}>
            <td>
              <b>{d.name}</b>
              {d.description && <div className="small text-muted mt-1">{d.description}</div>}
              {d.basis && <div className="small mt-1">依据：{d.basis}</div>}
            </td>
            <td>{d.weight}</td>
            <td>
              <ul className="mb-0 pl-3">
                {d.criteria.map((c, j) => (
                  <li key={j}>{c}</li>
                ))}
              </ul>
            </td>
            <td>
              {d.levels.map((lv, j) => (
                <div key={j} className="small mb-1">
                  <b>
                    {lv.label}
                    {lv.range && `（${lv.range}）`}
                  </b>
                  ：{lv.descriptor}
                </div>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {content.scoringNotes.length > 0 && (
      <div>
        <h6>评分说明</h6>
        <ul>
          {content.scoringNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </div>
    )}
  </>
);

// Criteria and 评分说明 are edited one-item-per-line; kept as raw text in the
// draft (criteriaText/notesText) so typing a blank line isn't swallowed
// mid-edit, and only split back into lists when checking/saving.
const toDraft = (content) => ({
  ...clone(content),
  notesText: content.scoringNotes.join("\n"),
  dimensions: content.dimensions.map((d) => ({ ...clone(d), criteriaText: d.criteria.join("\n") })),
});

const fromDraft = (draft) => ({
  title: draft.title,
  overview: draft.overview,
  totalScore: draft.totalScore,
  scoringNotes: lines(draft.notesText),
  dimensions: draft.dimensions.map(({ criteriaText, ...d }) => ({
    ...d,
    weight: Number(d.weight) || 0,
    criteria: lines(criteriaText),
  })),
});

const StandardEditor = ({ draft, onChange }) => {
  const update = (mutate) => {
    const next = clone(draft);
    mutate(next);
    onChange(next);
  };
  const total = draft.dimensions.reduce((sum, d) => sum + (Number(d.weight) || 0), 0);

  return (
    <div>
      <div className="form-group">
        <label className="small mb-1">标题</label>
        <input className="form-control" value={draft.title} onChange={(e) => update((n) => (n.title = e.target.value))} />
      </div>
      <div className="form-group">
        <label className="small mb-1">总体说明</label>
        <textarea
          className="form-control"
          rows={2}
          value={draft.overview}
          onChange={(e) => update((n) => (n.overview = e.target.value))}
        />
      </div>

      <div className={`mb-2 small ${total === draft.totalScore ? "text-success" : "text-danger"}`}>
        分值合计：{total} / {draft.totalScore}
      </div>

      {draft.dimensions.map((d, i) => (
        <div key={i} className="card mb-3">
          <div className="card-body py-2">
            <div className="form-row">
              <div className="col-md-5 form-group mb-2">
                <label className="small mb-1">维度名称</label>
                <input
                  className="form-control form-control-sm"
                  value={d.name}
                  onChange={(e) => update((n) => (n.dimensions[i].name = e.target.value))}
                />
              </div>
              <div className="col-md-2 form-group mb-2">
                <label className="small mb-1">分值</label>
                <input
                  type="number"
                  min="0"
                  className="form-control form-control-sm"
                  value={d.weight}
                  onChange={(e) => update((n) => (n.dimensions[i].weight = e.target.value))}
                />
              </div>
              <div className="col-md-5 text-right">
                <button
                  className="btn btn-link btn-sm text-danger"
                  onClick={() => update((n) => n.dimensions.splice(i, 1))}
                >
                  删除此维度
                </button>
              </div>
            </div>
            <div className="form-row">
              <div className="col-md-6 form-group mb-2">
                <label className="small mb-1">考察内容</label>
                <textarea
                  className="form-control form-control-sm"
                  rows={2}
                  value={d.description}
                  onChange={(e) => update((n) => (n.dimensions[i].description = e.target.value))}
                />
              </div>
              <div className="col-md-6 form-group mb-2">
                <label className="small mb-1">依据</label>
                <textarea
                  className="form-control form-control-sm"
                  rows={2}
                  value={d.basis}
                  onChange={(e) => update((n) => (n.dimensions[i].basis = e.target.value))}
                />
              </div>
            </div>
            <div className="form-group mb-2">
              <label className="small mb-1">评分要点（每行一条）</label>
              <textarea
                className="form-control form-control-sm"
                rows={3}
                value={d.criteriaText}
                onChange={(e) => update((n) => (n.dimensions[i].criteriaText = e.target.value))}
              />
            </div>
            <label className="small mb-1">等级描述</label>
            {d.levels.map((lv, j) => (
              <div key={j} className="form-row mb-1">
                <div className="col-2">
                  <input
                    className="form-control form-control-sm"
                    placeholder="等级"
                    value={lv.label}
                    onChange={(e) => update((n) => (n.dimensions[i].levels[j].label = e.target.value))}
                  />
                </div>
                <div className="col-2">
                  <input
                    className="form-control form-control-sm"
                    placeholder="如 18-20"
                    value={lv.range}
                    onChange={(e) => update((n) => (n.dimensions[i].levels[j].range = e.target.value))}
                  />
                </div>
                <div className="col-7">
                  <textarea
                    className="form-control form-control-sm"
                    rows={2}
                    placeholder="判定描述"
                    value={lv.descriptor}
                    onChange={(e) => update((n) => (n.dimensions[i].levels[j].descriptor = e.target.value))}
                  />
                </div>
                <div className="col-1">
                  <button
                    className="btn btn-link btn-sm text-danger p-0"
                    title="删除此等级"
                    onClick={() => update((n) => n.dimensions[i].levels.splice(j, 1))}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <button
              className="btn btn-link btn-sm p-0"
              onClick={() => update((n) => n.dimensions[i].levels.push({ label: "", range: "", descriptor: "" }))}
            >
              + 添加等级
            </button>
          </div>
        </div>
      ))}

      <button
        className="btn btn-outline-secondary btn-sm mb-3"
        onClick={() =>
          update((n) =>
            n.dimensions.push({
              name: "",
              weight: 0,
              description: "",
              basis: "",
              criteriaText: "",
              levels: DEFAULT_LEVELS.map((label) => ({ label, range: "", descriptor: "" })),
            })
          )
        }
      >
        + 添加评分维度
      </button>

      <div className="form-group">
        <label className="small mb-1">评分说明（每行一条）</label>
        <textarea
          className="form-control"
          rows={4}
          value={draft.notesText}
          onChange={(e) => update((n) => (n.notesText = e.target.value))}
        />
      </div>
    </div>
  );
};

// AI 点评 -> AI 点评标准 (expert/admin only). The standard starts out
// AI-synthesized from 学习资源库 (see backend services/aiReviewStandard.js);
// experts/admins can then override it. Every override goes through a
// structural + AI check against the same materials, and is saved as a new
// version attributed to its operator along with the cautions they accepted.
// The newest version is the one in effect.
const AiReviewStandard = () => {
  const [active, setActive] = useState(null);
  const [viewed, setViewed] = useState(null); // a historical version, or null for the active one
  const [versions, setVersions] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");

  const [draft, setDraft] = useState(null); // non-null while editing
  const [baseId, setBaseId] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [check, setCheck] = useState(null); // { cautions, signature } for the current draft
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  const autoStarted = useRef(false);
  const activeIdRef = useRef(null);
  const allowed = AuthService.isExpert() || AuthService.isAdmin();
  const editing = !!draft;

  const loadVersions = useCallback(() => {
    AiReviewDataService.listVersions()
      .then((res) => setVersions(res.data))
      .catch(() => {});
  }, []);

  const startGeneration = useCallback(() => {
    setMessage("");
    setGenerating(true);
    AiReviewDataService.generateStandard().catch((e) => {
      setGenerating(false);
      setMessage(errorText(e));
    });
  }, []);

  const refresh = useCallback(() => {
    return AiReviewDataService.getStandard()
      .then((res) => {
        const { standard: latest, generating: running, lastError } = res.data;
        // Reload history only when a new version appeared (first load, or a
        // background generation just finished), not on every poll.
        const latestId = latest ? latest.id : null;
        if (latestId !== activeIdRef.current) {
          activeIdRef.current = latestId;
          if (latest) loadVersions();
        }
        setActive(latest);
        setGenerating(running);
        setLoaded(true);
        if (!running && lastError) setMessage(`生成失败：${lastError}`);
        if (!latest && !running && !lastError && !autoStarted.current) {
          autoStarted.current = true;
          startGeneration();
        }
      })
      .catch((e) => {
        setLoaded(true);
        setMessage(errorText(e));
      });
  }, [startGeneration, loadVersions]);

  useEffect(() => {
    if (allowed) refresh();
  }, [allowed, refresh]);

  useEffect(() => {
    if (!generating) return undefined;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [generating, refresh]);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (!dirty || consumeSkipUnsavedWarning()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  if (!allowed) {
    return <div className="alert alert-warning">AI 点评仅对专家和管理员开放。</div>;
  }

  const shown = viewed || active;

  const viewVersion = (id) => {
    setMessage("");
    if (active && id === active.id) {
      setViewed(null);
      return;
    }
    AiReviewDataService.getVersion(id)
      .then((res) => setViewed(res.data))
      .catch((e) => setMessage(errorText(e)));
  };

  const startEditing = () => {
    setMessage("");
    setDraft(toDraft(shown.content));
    setBaseId(shown.id);
    setDirty(false);
    setChangeNote("");
    setCheck(null);
  };

  const cancelEditing = () => {
    if (dirty && !window.confirm("放弃未保存的修订吗？")) return;
    setDraft(null);
    setDirty(false);
    setCheck(null);
  };

  const onDraftChange = (next) => {
    setDraft(next);
    setDirty(true);
    setCheck(null); // any edit invalidates the previous check
  };

  const runCheck = () => {
    setMessage("");
    setChecking(true);
    return AiReviewDataService.checkRevision(fromDraft(draft), baseId)
      .then((res) => {
        setCheck({ cautions: res.data.cautions, signature: res.data.signature });
        return res.data;
      })
      .catch((e) => {
        setMessage(errorText(e));
        return null;
      })
      .finally(() => setChecking(false));
  };

  // Saving always goes through a check first: the operator must have seen
  // the cautions for exactly this draft before it can become the standard.
  const save = async () => {
    if (!check) {
      const result = await runCheck();
      if (result) setMessage("已完成核查，请查看下方提醒后再次点击「保存为新版本」。");
      return;
    }
    const n = cautionCount(check.cautions);
    if (n > 0 && !window.confirm(`核查共提出 ${n} 条提醒。确定仍要保存为新版本并立即生效吗？`)) return;

    setSaving(true);
    setMessage("");
    try {
      const res = await AiReviewDataService.saveRevision({
        content: fromDraft(draft),
        baseId,
        changeNote,
        cautions: check.cautions,
        signature: check.signature,
      });
      setDraft(null);
      setDirty(false);
      setCheck(null);
      setViewed(null);
      activeIdRef.current = res.data.id;
      setActive(res.data);
      loadVersions();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const hasBlockingError = check && check.cautions.structural.some((c) => c.level === "error");
  const content = shown && shown.content;

  return (
    <div className="container">
      <Prompt when={dirty} message="有未保存的标准修订，确定要离开吗？" />

      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">AI 点评标准</h4>
        {!editing && (
          <div>
            {versions.length > 0 && (
              <button className="btn btn-outline-secondary btn-sm mr-2" onClick={() => setShowHistory(!showHistory)}>
                版本历史（{versions.length}）
              </button>
            )}
            {shown && (
              <button className="btn btn-outline-primary btn-sm mr-2" disabled={generating} onClick={startEditing}>
                {viewed ? "基于此版本修订" : "修订标准"}
              </button>
            )}
            <button
              className="btn btn-outline-primary btn-sm"
              disabled={generating}
              onClick={() => {
                const warning =
                  active && active.source === "human"
                    ? "当前生效的标准包含人工修订，重新生成将由 AI 从学习资源库重新制定，不会保留这些修订。确定继续吗？"
                    : "将基于学习资源库的当前内容重新生成评分标准，之后的 AI 点评将采用新标准。确定继续吗？";
                if (!active || window.confirm(warning)) startGeneration();
              }}
            >
              {generating ? "生成中…" : active ? "重新生成" : "生成标准"}
            </button>
          </div>
        )}
      </div>

      {message && <div className="alert alert-info">{message}</div>}

      {generating && (
        <div className="alert alert-info">
          <span className="spinner-border spinner-border-sm mr-2" role="status" />
          正在分析、综合学习资源库中的材料以生成评分标准，通常需要一到两分钟…
        </div>
      )}

      {showHistory && !editing && (
        <div className="list-group mb-3">
          {versions.map((v) => (
            <button
              key={v.id}
              className={`list-group-item list-group-item-action py-2 small ${shown && shown.id === v.id ? "active" : ""}`}
              onClick={() => viewVersion(v.id)}
            >
              <b>版本 #{v.id}</b>
              {active && v.id === active.id && <span className="badge badge-success ml-2">当前生效</span>}
              <span className="ml-2">
                {v.source === "human"
                  ? `人工修订${v.operator ? `（${v.operator.name}）` : ""}，基于 #${v.baseId}`
                  : "AI 生成"}
              </span>
              <span className="ml-2">{new Date(v.createdAt).toLocaleString()}</span>
              {v.changeNote && <div className={shown && shown.id === v.id ? "" : "text-muted"}>{v.changeNote}</div>}
            </button>
          ))}
        </div>
      )}

      {loaded && !content && !generating && !message && <p className="text-muted">暂无评分标准。</p>}

      {editing ? (
        <div>
          <div className="alert alert-secondary small">
            正在基于版本 #{baseId} 修订。保存前会进行结构核查，并由 AI 对照学习资源库检查修订是否有材料依据；保存后将成为新的生效版本，并记录您为修订人。
          </div>
          <StandardEditor draft={draft} onChange={onDraftChange} />

          <div className="form-group">
            <label className="small mb-1">修订说明</label>
            <textarea
              className="form-control"
              rows={2}
              placeholder="说明本次修订的内容与理由"
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
            />
          </div>

          {checking && (
            <div className="alert alert-info">
              <span className="spinner-border spinner-border-sm mr-2" role="status" />
              AI 正在对照学习资源库核查本次修订，可能需要一分钟左右…
            </div>
          )}
          {check && <CautionsPanel cautions={check.cautions} />}

          <div className="mb-4">
            <button className="btn btn-outline-primary mr-2" disabled={checking || saving} onClick={runCheck}>
              AI 核查
            </button>
            <button className="btn btn-primary mr-2" disabled={checking || saving || hasBlockingError} onClick={save}>
              {saving ? "保存中…" : "保存为新版本"}
            </button>
            <button className="btn btn-link" disabled={checking || saving} onClick={cancelEditing}>
              取消
            </button>
          </div>
        </div>
      ) : (
        content && (
          <div>
            {viewed && (
              <div className="alert alert-warning small">
                正在查看历史版本 #{viewed.id}（非当前生效版本）。
                <button className="btn btn-link btn-sm p-0 ml-2" onClick={() => setViewed(null)}>
                  返回当前版本
                </button>
              </div>
            )}
            <h5>{content.title}</h5>
            <p className="text-muted small">
              版本 #{shown.id} · {new Date(shown.createdAt).toLocaleString()}
              {shown.source === "human"
                ? ` · 人工修订${shown.operator ? `：${shown.operator.name}` : ""}（基于版本 #${shown.baseId}）`
                : ` · AI 生成${shown.aiModel ? `（${shown.aiModel}）` : ""}`}
              {Array.isArray(shown.sourceTopicIds) && ` · 依据学习资源库 ${shown.sourceTopicIds.length} 个主题`}
              {` · 满分 ${content.totalScore}`}
            </p>
            {shown.changeNote && <p className="small">修订说明：{shown.changeNote}</p>}
            {shown.cautions && cautionCount(shown.cautions) > 0 && (
              <details className="mb-3">
                <summary className="small text-muted">保存时已知悉的核查提醒（{cautionCount(shown.cautions)} 条）</summary>
                <div className="mt-2">
                  <CautionsPanel cautions={shown.cautions} />
                </div>
              </details>
            )}
            <RetrievalSources retrieval={shown.retrieval} />
            <StandardTable content={content} />
          </div>
        )
      )}
    </div>
  );
};

export default AiReviewStandard;
