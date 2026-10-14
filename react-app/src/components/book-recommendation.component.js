import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useHistory, useParams } from "react-router-dom";
import Select from "react-select";
import BookRecommendationDataService from "../services/book-recommendation.service";
import AuthService from "../services/auth.service";
import { schoolFilterOption } from "../constants/school-options";
import "../curriculum.css";

const POLL_INTERVAL_MS = 3000;
const BASE_PATH = "/admin/book-recommendations";

const errorText = (e) => {
  const data = e.response && e.response.data;
  // An arraybuffer (export) error response carries its JSON as bytes.
  if (data instanceof ArrayBuffer) {
    try {
      return JSON.parse(new TextDecoder().decode(data)).message;
    } catch (_) {
      return e.message;
    }
  }
  return (data && data.message) || e.message;
};
const fmtTime = (d) => (d ? new Date(d).toLocaleString() : "");
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "");

const formatSchoolOptionLabel = (option) => (
  <div>
    <div>{option.label}</div>
    {option.address && <div style={{ fontSize: "0.85em", color: "#6c757d" }}>{option.address}</div>}
  </div>
);

const STEP_LABELS = { guidance: "检索地方规定", search: "检索图书信息", evaluate: "AI 合规评估" };

const statusBadge = (run) => {
  if (run.status === "running") return <span className="badge badge-info">运行中</span>;
  if (run.status === "failed") return <span className="badge badge-danger">失败</span>;
  return <span className="badge badge-success">已完成</span>;
};

const download = (data, type, fileName) => {
  const url = window.URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
};

// ---------------------------------------------------------------------------
// Guidance (the province's rules) -- shown on a run and in the cache list
// ---------------------------------------------------------------------------

const GuidanceView = ({ guidance }) => {
  const c = guidance.content;
  return (
    <div className="small">
      <div className="mb-2">
        <b>依据文件：</b>
        {c.documents.length === 0 && <span className="text-muted">无</span>}
        <ul className="mb-1">
          {c.documents.map((d, i) => (
            <li key={i}>
              {d.level && <span className="badge badge-light mr-1">{d.level}</span>}《{d.title}》{d.issuer && ` ${d.issuer}`}
              {d.year && ` ${d.year}`}
            </li>
          ))}
        </ul>
        {!c.hasProvincialRules && <div className="text-warning">未检索到本省专门文件，以国家规定为准。</div>}
      </div>
      <div className="mb-2">
        <b>禁止进校园的情形（红线）：</b>
        <ol className="mb-1">
          {c.redLines.map((r, i) => (
            <li key={i}>
              <span className="text-muted mr-1">R{i + 1}</span>
              {r}
            </li>
          ))}
        </ol>
      </div>
      {c.principles.length > 0 && (
        <div className="mb-2">
          <b>推荐原则：</b>
          <ul className="mb-1">
            {c.principles.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {Object.values(c.stageGuidance || {}).some(Boolean) && (
        <div className="mb-2">
          <b>学段要求：</b>
          <ul className="mb-1">
            {Object.entries(c.stageGuidance)
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <li key={k}>
                  {k} 年级：{v}
                </li>
              ))}
          </ul>
        </div>
      )}
      {c.localNotes.length > 0 && (
        <div className="mb-2">
          <b>本省特别要求：</b>
          <ul className="mb-1">
            {c.localNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {guidance.sources && guidance.sources.length > 0 && (
        <details>
          <summary className="text-muted">检索来源（{guidance.sources.length}）</summary>
          <ul>
            {guidance.sources.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
                {s.site && <span className="text-muted"> · {s.site}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="text-muted">检索于 {fmtTime(guidance.fetchedAt)}</div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

const BookTable = ({ books, mode }) => {
  const [open, setOpen] = useState(null);
  if (books.length === 0) return <p className="text-muted small">无</p>;
  return (
    <table className="table table-bordered table-sm">
      <thead className="thead-light">
        <tr>
          <th style={{ width: "4%" }}>#</th>
          <th style={{ width: "36%" }}>图书</th>
          <th style={{ width: "10%" }}>豆瓣评分</th>
          {mode === "exclude" && <th style={{ width: "8%" }}>依据</th>}
          <th>{mode === "recommend" ? "推荐理由" : mode === "exclude" ? "原因" : "说明"}</th>
        </tr>
      </thead>
      <tbody>
        {books.map((b, i) => {
          const isOpen = open === b.index;
          return (
            <React.Fragment key={b.index}>
              <tr style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : b.index)}>
                <td>{i + 1}</td>
                <td>
                  <b>{b.title}</b>
                  {b.isbnMismatch && (
                    <span className="badge badge-warning ml-1" title={`上传的 ISBN 为 ${b.inputIsbn}，检索到的为 ${b.foundIsbn}`}>
                      新ISBN
                    </span>
                  )}
                  {b.concerns.length > 0 && <span className="badge badge-danger ml-1">有疑点</span>}
                  <div className="small text-muted">
                    {[b.author, b.publisher && `${b.publisher}${b.year ? ` ${b.year}` : ""}`, b.isbn && `ISBN ${b.isbn}`].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className="small">
                  {b.rating !== null && b.rating !== undefined ? (
                    <>
                      <b className={b.rating >= 8 ? "text-success" : b.rating < 6.5 ? "text-danger" : ""}>{b.rating}</b>
                      <div className="text-muted">{b.ratingCount || 0} 人</div>
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                {mode === "exclude" && <td className="small">{b.rule}</td>}
                <td className="small">{b.reason}</td>
              </tr>
              {isOpen && (
                <tr>
                  <td colSpan={mode === "exclude" ? 5 : 4} className="bg-light small">
                    {b.summary ? <p className="mb-1">{b.summary}</p> : <p className="text-muted mb-1">未检索到内容简介。</p>}
                    {b.themes.length > 0 && <div>主题：{b.themes.join("、")}</div>}
                    {b.endorsements.length > 0 && <div>获奖 / 入选：{b.endorsements.join("、")}</div>}
                    {b.concerns.length > 0 && <div className="text-danger">疑点：{b.concerns.join("；")}</div>}
                    {b.inputTitle && b.inputTitle !== b.title && <div className="text-muted">上传书名：{b.inputTitle}</div>}
                    {b.sources.length > 0 && (
                      <div className="mt-1">
                        来源：
                        {b.sources.slice(0, 6).map((s, j) => (
                          <a key={j} href={s.url} target="_blank" rel="noopener noreferrer" className="mr-2" onClick={(e) => e.stopPropagation()}>
                            {s.site || s.title || "链接"}
                          </a>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
};

const RunDetail = ({ id }) => {
  const history = useHistory();
  const [run, setRun] = useState(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    (opts) =>
      BookRecommendationDataService.getRun(id, opts)
        .then((res) => setRun(res.data))
        .catch((e) => setMessage(errorText(e))),
    [id]
  );
  useEffect(() => {
    setRun(null);
    setTab(null);
    refresh();
  }, [refresh]);

  const running = !!(run && run.status === "running");
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => refresh({ background: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const exportAs = async (format) => {
    setBusy(true);
    try {
      const resp = await BookRecommendationDataService.exportRun(id, format);
      const type =
        format === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      download(resp.data, type, `课外读物推荐_${run.schoolName}_${run.id}.${format}`);
    } catch (e) {
      setMessage(`导出失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const rerun = () => {
    if (!window.confirm("用同一书目和学校重新运行？已检索过的图书和地方规定会直接复用缓存。")) return;
    BookRecommendationDataService.rerun(id)
      .then((res) => history.push(`${BASE_PATH}/${res.data.id}`))
      .catch((e) => setMessage(errorText(e)));
  };

  if (!run) return message ? <div className="alert alert-danger">{message}</div> : <p className="text-muted">加载中…</p>;

  const result = run.result;
  const tabs = result
    ? [
        ...result.stages.map((s) => ({ key: s.key, label: `${s.label}（${s.books.length}）`, books: s.books, mode: "recommend" })),
        { key: "exclude", label: `不推荐（${result.excluded.length}）`, books: result.excluded, mode: "exclude" },
        { key: "review", label: `待人工复核（${result.review.length}）`, books: result.review, mode: "review" },
        { key: "guidance", label: "依据规定" },
      ]
    : [];
  const shown = tabs.find((t) => t.key === tab) || tabs[0];
  const p = run.progress;

  return (
    <div>
      <Link to={BASE_PATH} className="small">
        <i className="fas fa-arrow-left mr-1" />
        返回推荐记录
      </Link>
      <div className="d-flex justify-content-between align-items-start mt-2 mb-2">
        <div>
          <h5 className="mb-1">
            {run.schoolName} {statusBadge(run)}
          </h5>
          <div className="small text-muted">
            {run.province} · 书目「{run.fileName}」共 {run.bookCount} 本 · 发起于 {fmtTime(run.createdAt)}
            {run.finishedAt && ` · 完成于 ${fmtTime(run.finishedAt)}`}
          </div>
        </div>
        <div className="text-nowrap">
          {run.status === "done" && (
            <>
              <button className="btn btn-outline-secondary btn-sm mr-2" disabled={busy} onClick={() => exportAs("xlsx")}>
                <i className="fas fa-file-excel mr-1" />
                导出 Excel
              </button>
              <button className="btn btn-outline-secondary btn-sm mr-2" disabled={busy} onClick={() => exportAs("docx")}>
                <i className="fas fa-file-word mr-1" />
                导出 Word
              </button>
            </>
          )}
          {!running && (
            <button className="btn btn-outline-primary btn-sm" onClick={rerun}>
              重新运行
            </button>
          )}
        </div>
      </div>
      {message && <div className="alert alert-danger">{message}</div>}

      {running && (
        <div className="alert alert-info">
          <span className="spinner-border spinner-border-sm mr-2" role="status" />
          {p ? STEP_LABELS[p.step] : "处理中"}
          {p && p.step === "search" && `：${p.searched} / ${p.total}`}
          <div className="small text-muted mt-1">每本书需联网检索，首次检索约 20-40 秒/本；已检索过的图书和地方规定直接使用缓存。</div>
          <div className="progress mt-2" style={{ height: 8 }}>
            <div
              className="progress-bar progress-bar-striped progress-bar-animated"
              style={{
                width: `${Math.max(p && p.step === "search" && p.total ? (p.searched / p.total) * 90 : p && p.step === "evaluate" ? 92 : 3, 3)}%`,
              }}
            />
          </div>
        </div>
      )}
      {run.status === "failed" && <div className="alert alert-danger">{run.error}</div>}

      {result && (
        <>
          <p className="small mb-2">
            共 {result.counts.total} 本：推荐 <b className="text-success">{result.counts.recommended}</b> 本，不推荐{" "}
            <b className="text-danger">{result.counts.excluded}</b> 本，待人工复核 <b>{result.counts.review}</b> 本。点击行查看简介与来源。
            AI 生成的结果，正式使用前请人工审核。
          </p>
          <ul className="nav nav-tabs mb-2">
            {tabs.map((t) => (
              <li className="nav-item" key={t.key}>
                <button type="button" className={`nav-link btn btn-link btn-sm ${shown.key === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
          {shown.key === "guidance" ? (
            run.guidance ? (
              <GuidanceView guidance={run.guidance} />
            ) : (
              <p className="text-muted small">无</p>
            )
          ) : (
            <BookTable key={shown.key} books={shown.books} mode={shown.mode} />
          )}
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// New run form + history + caches
// ---------------------------------------------------------------------------

const NewRunForm = ({ options, onStarted }) => {
  const [school, setSchool] = useState(null);
  const [stages, setStages] = useState([]);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const schoolOptions = useMemo(
    () => options.schools.map((s) => ({ value: s.code, label: s.name, address: s.address, school: s })),
    [options]
  );

  const pickSchool = (option) => {
    setSchool(option);
    setStages(option ? option.school.stages : []);
  };
  const toggleStage = (key) => setStages((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const submit = (e) => {
    e.preventDefault();
    setMessage("");
    setSubmitting(true);
    BookRecommendationDataService.startRun({ file, schoolCode: school.value, stages })
      .then((res) => {
        setFile(null);
        setFileKey((k) => k + 1);
        onStarted(res.data.id);
      })
      .catch((err) => setMessage(errorText(err)))
      .finally(() => setSubmitting(false));
  };

  return (
    <form className="card card-body mb-4" onSubmit={submit}>
      <h6 className="mb-3">新建推荐</h6>
      <div className="form-row">
        <div className="form-group col-md-6">
          <label htmlFor="bookRecSchool">受赠学校</label>
          <Select
            inputId="bookRecSchool"
            options={schoolOptions}
            value={school}
            onChange={pickSchool}
            placeholder="搜索学校（名称/代码/地址）"
            formatOptionLabel={formatSchoolOptionLabel}
            filterOption={schoolFilterOption}
            isClearable
          />
        </div>
        <div className="form-group col-md-3">
          {/* Fixed by the school's address (backend provinceOf) -- the
              rules applied must be the school's actual province's. */}
          <label htmlFor="bookRecProvince">所在省份</label>
          <input
            id="bookRecProvince"
            className="form-control"
            value={school ? school.school.province : ""}
            placeholder="选择学校后自动确定"
            readOnly
            disabled
          />
        </div>
      </div>
      <div className="form-group">
        <label className="d-block">推荐学段（按课程标准学段分组）</label>
        {options.stages.map((s) => (
          <div className="form-check form-check-inline" key={s.key}>
            <input className="form-check-input" type="checkbox" id={`stage-${s.key}`} checked={stages.includes(s.key)} onChange={() => toggleStage(s.key)} />
            <label className="form-check-label" htmlFor={`stage-${s.key}`}>
              {s.label}
            </label>
          </div>
        ))}
      </div>
      <div className="form-group">
        <label>书目文件（.xlsx / .csv）</label>
        <input key={fileKey} type="file" className="form-control-file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files[0] || null)} />
        <small className="form-text text-muted">
          第一行为表头，需包含「书名」和/或「ISBN」（或「书号」）列；可选列：作者、出版社、出版年。一次最多 500 本。
        </small>
      </div>
      {message && <div className="alert alert-danger small">{message}</div>}
      <div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={submitting || !school || stages.length === 0 || !file}>
          {submitting ? "提交中…" : "开始推荐"}
        </button>
      </div>
    </form>
  );
};

const GuidanceCache = () => {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const [message, setMessage] = useState("");
  const refresh = useCallback(
    (opts) =>
      BookRecommendationDataService.listGuidances(opts)
        .then((res) => setRows(res.data))
        .catch((e) => setMessage(errorText(e))),
    []
  );
  useEffect(() => {
    refresh();
  }, [refresh]);
  const anyRefreshing = rows.some((r) => r.refreshing);
  useEffect(() => {
    if (!anyRefreshing) return undefined;
    const timer = setInterval(() => refresh({ background: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [anyRefreshing, refresh]);

  const renew = (province) => {
    if (!window.confirm(`重新联网检索${province}的课外读物进校园规定？约需 1-2 分钟。`)) return;
    BookRecommendationDataService.refreshGuidance(province)
      .then(() => setRows((prev) => prev.map((r) => (r.province === province ? { ...r, refreshing: true } : r))))
      .catch((e) => setMessage(errorText(e)));
  };

  return (
    <div className="mb-4">
      <h6>地方规定（已缓存，半年自动更新）</h6>
      {message && <div className="alert alert-danger small">{message}</div>}
      {rows.length === 0 ? (
        <p className="text-muted small">暂无。首次为某省推荐时会自动检索该省规定。</p>
      ) : (
        <table className="table table-sm table-bordered small">
          <thead className="thead-light">
            <tr>
              <th>省份</th>
              <th>依据文件</th>
              <th>红线</th>
              <th>检索时间</th>
              <th style={{ width: 110 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={r.province}>
                <tr style={{ cursor: "pointer" }} onClick={() => setOpen(open === r.province ? null : r.province)}>
                  <td>
                    {r.province}
                    {!r.content.hasProvincialRules && <span className="badge badge-light ml-1">仅国家规定</span>}
                  </td>
                  <td>{r.content.documents.length} 份</td>
                  <td>{r.content.redLines.length} 条</td>
                  <td>
                    {fmtDate(r.fetchedAt)}
                    {r.stale && <span className="badge badge-warning ml-1">待更新</span>}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {r.refreshing ? (
                      <span className="text-muted">
                        <span className="spinner-border spinner-border-sm mr-1" />
                        检索中
                      </span>
                    ) : (
                      <button className="btn btn-link btn-sm p-0" onClick={() => renew(r.province)}>
                        重新检索
                      </button>
                    )}
                  </td>
                </tr>
                {open === r.province && (
                  <tr>
                    <td colSpan={5} className="bg-light">
                      <GuidanceView guidance={r} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const SKILL_LABELS = { book_search: "图书检索", guidance_search: "指导检索" };

const SkillNotes = () => {
  const [notes, setNotes] = useState(null);
  useEffect(() => {
    BookRecommendationDataService.getSkillNotes()
      .then((res) => setNotes(res.data))
      .catch(() => setNotes({}));
  }, []);
  if (!notes) return null;
  return (
    <details className="mb-4">
      <summary>
        <h6 className="d-inline">技能经验（每次运行后自动总结改进）</h6>
      </summary>
      <div className="row mt-2">
        {Object.entries(SKILL_LABELS).map(([key, label]) => {
          const n = notes[key] || { notes: [] };
          return (
            <div className="col-md-6 small" key={key}>
              <b>{label}</b>
              <span className="text-muted ml-1">
                {n.revision ? `第 ${n.revision} 版 · ${fmtTime(n.updatedAt)}` : "尚无经验"}
              </span>
              <ol className="mt-1">
                {n.notes.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
    </details>
  );
};

const RunList = () => {
  const history = useHistory();
  const [options, setOptions] = useState(null);
  const [runs, setRuns] = useState([]);
  const [message, setMessage] = useState("");

  const refresh = useCallback(
    (opts) =>
      BookRecommendationDataService.listRuns(opts)
        .then((res) => setRuns(res.data))
        .catch((e) => setMessage(errorText(e))),
    []
  );
  useEffect(() => {
    BookRecommendationDataService.getOptions()
      .then((res) => setOptions(res.data))
      .catch((e) => setMessage(errorText(e)));
    refresh();
  }, [refresh]);

  const anyRunning = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(() => refresh({ background: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [anyRunning, refresh]);

  const remove = (run) => {
    if (!window.confirm(`删除「${run.schoolName}」的这次推荐记录？`)) return;
    BookRecommendationDataService.deleteRun(run.id)
      .then(() => refresh())
      .catch((e) => setMessage(errorText(e)));
  };

  return (
    <div>
      <p className="text-muted small">
        上传书目并选择受赠学校，系统先检索学校所在省份的课外读物进校园规定（国家《中小学生课外读物进校园管理办法》及省级规定），
        再逐本检索图书信息（豆瓣读书 ISBN 页面及联网检索），由 AI 对照规定判断是否推荐，并按课程标准学段分组。
        检索结果会缓存复用，检索技能会根据每次运行的经验自动改进。
      </p>
      {message && <div className="alert alert-danger">{message}</div>}
      {options && <NewRunForm options={options} onStarted={(id) => history.push(`${BASE_PATH}/${id}`)} />}

      <h6>推荐记录</h6>
      {runs.length === 0 ? (
        <p className="text-muted small mb-4">暂无。</p>
      ) : (
        <table className="table table-sm table-bordered table-hover small mb-4">
          <thead className="thead-light">
            <tr>
              <th>学校</th>
              <th>省份</th>
              <th>书目</th>
              <th>结果</th>
              <th>发起时间</th>
              <th style={{ width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => history.push(`${BASE_PATH}/${r.id}`)}>
                <td>{r.schoolName}</td>
                <td>{r.province}</td>
                <td>
                  {r.fileName}（{r.bookCount} 本）
                </td>
                <td>
                  {statusBadge(r)}{" "}
                  {r.status === "running" && r.progress && `${STEP_LABELS[r.progress.step] || ""}${r.progress.step === "search" ? ` ${r.progress.searched}/${r.progress.total}` : ""}`}
                  {r.counts && `推荐 ${r.counts.recommended} · 不推荐 ${r.counts.excluded} · 待复核 ${r.counts.review}`}
                </td>
                <td>{fmtTime(r.createdAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {r.status !== "running" && (
                    <button className="btn btn-link btn-sm p-0 text-danger" onClick={() => remove(r)}>
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <GuidanceCache />
      <SkillNotes />
    </div>
  );
};

// 课外读物推荐 (super-only): /admin/book-recommendations lists runs and
// starts new ones; /admin/book-recommendations/:id shows one run's result.
const BookRecommendation = () => {
  const { id } = useParams();
  if (!AuthService.isSuper()) {
    return <div className="alert alert-warning">课外读物推荐仅对超级管理员开放。</div>;
  }
  return (
    <div className="container">
      <h4 className="mb-3">课外读物推荐</h4>
      {id ? <RunDetail id={id} /> : <RunList />}
    </div>
  );
};

export default BookRecommendation;
