import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useHistory, useLocation } from "react-router-dom";
import Select from "react-select";
import AsyncSelect from "react-select/async";

import {
  ShareTopicDataService,
  ShareDataService,
  ShareFolderDataService,
  ShareArtifactDataService,
} from "../services/teacher-share.service";
import PlanDataService from "../services/plan.service";
import AuthService from "../services/auth.service";
import LessonFileManager from "./lesson-file-manager.component";
import { useExplorerPane, ExplorerPaneBar } from "./explorer-pane";
import { SCHOOLS, schoolFilterOption } from "../constants/school-options";
import "../curriculum.css";

// 教师分享 -- teachers share their views on an admin-defined 话题 (e.g.
// "一堂乡土课程带来的影响"). Laid out like materials-library.component.js:
// the 话题 tree on the left (each 话题 expanding to its shares), the picked
// 话题's share list or one share on the right. A share's files reuse
// lesson-file-manager.component.js's cloud file system via the
// ShareFolder/ShareArtifact services.
//
// Who does what (enforced server-side too): every logged-in user reads;
// admins define 话题, which lock (no edit/delete) once a share exists under
// them; teachers and admins share; a share's author or an admin edits or
// deletes it.
//
// Search works like 全部乡土课程's (plans-hierarchy.component.js): every
// share is fetched once and filtered client-side by 话题 / 教师姓名 / 学校,
// with the filters and the current selection kept in the URL so 返回 from a
// related plan lands back on the same view.
const EMPTY_TOPIC_FORM = { title: "", description: "" };
const EMPTY_SHARE_FORM = { title: "", summary: "", relatedPlan: null, author: null };
const LOCKED_TITLE = "该话题下已有分享，不能修改或删除";

const planOption = (plan) =>
  plan
    ? {
        value: plan.id,
        label: plan.Teacher ? `${plan.title}（${plan.Teacher.chineseName || plan.Teacher.username}）` : plan.title,
      }
    : null;

const authorLabel = (share) => {
  const a = share.Author;
  if (!a) return "-";
  const name = a.chineseName || a.username;
  return a.School ? `${name} · ${a.School.name}` : name;
};

// { value, label } for the admin's 作者教师 picker, from a user row with School.
const teacherOption = (user) =>
  user
    ? { value: user.id, label: user.School ? `${user.chineseName || user.username}（${user.School.name}）` : user.chineseName || user.username }
    : null;

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("zh-cn") : "");

const authorName = (share) => (share.Author ? share.Author.chineseName || share.Author.username : "");
const UNASSIGNED_SCHOOL_NAME = "未分配学校";
const schoolNameOf = (share) => (share.Author && share.Author.School ? share.Author.School.name : UNASSIGNED_SCHOOL_NAME);

const formatSchoolOptionLabel = (option) => (
  <div>
    <div>{option.label}</div>
    {option.address && <div style={{ fontSize: "0.85em", color: "#6c757d" }}>{option.address}</div>}
  </div>
);

const TeacherShare = () => {
  const isLogin = !!AuthService.isLogin();
  const isAdmin = AuthService.isAdmin();
  const canShare = isAdmin || AuthService.isTeacher();
  // An admin uploads a share on a teacher's behalf (picking the author); a
  // teacher shares their own.
  const shareActionLabel = isAdmin ? "上传分享" : "我要分享";
  const location = useLocation();
  const history = useHistory();
  const pane = useExplorerPane();
  // Read once on mount -- this page's own URL sync below rewrites the URL.
  const initialParams = useMemo(() => new URLSearchParams(location.search || ""), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [topics, setTopics] = useState([]);
  const [allShares, setAllShares] = useState(null); // null = not loaded yet
  const [filterTopicId, setFilterTopicId] = useState(() => initialParams.get("topicFilter") || "");
  const [filterTeacherName, setFilterTeacherName] = useState(() => initialParams.get("teacherName") || "");
  const [filterSchoolName, setFilterSchoolName] = useState(() => initialParams.get("schoolName") || "");
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [expandedTopics, setExpandedTopics] = useState({});
  // view: "topic" (a 话题's share list) | "share" (one share) | "create" (new share form)
  const [selected, setSelected] = useState({ topicId: null, shareId: null, view: null });

  const [isCreatingTopic, setIsCreatingTopic] = useState(false);
  const [topicForm, setTopicForm] = useState(EMPTY_TOPIC_FORM);
  const [editingTopicId, setEditingTopicId] = useState(null);
  const [busyTopicId, setBusyTopicId] = useState(null);

  const [share, setShare] = useState(null);
  const [isLoadingShare, setIsLoadingShare] = useState(false);
  const [shareForm, setShareForm] = useState(EMPTY_SHARE_FORM);
  const [isEditingShare, setIsEditingShare] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const retrieveTopics = useCallback(async () => {
    try {
      const resp = await ShareTopicDataService.getAll();
      setTopics(Array.isArray(resp.data) ? resp.data : []);
    } catch (e) {
      setMessage(e?.response?.data?.message || "加载分享话题失败。");
    }
  }, []);

  const retrieveShares = useCallback(async () => {
    try {
      const resp = await ShareDataService.getAll();
      setAllShares(Array.isArray(resp.data) ? resp.data : []);
    } catch (e) {
      setMessage(e?.response?.data?.message || "加载教师分享失败。");
    }
  }, []);

  // ?topic=ID / ?share=ID open straight on that 话题 or share (欣欣小助手's
  // links, a link someone pasted, or 返回 to this page).
  useEffect(() => {
    if (!isLogin) return;
    (async () => {
      await Promise.all([retrieveTopics(), retrieveShares()]);
      const shareId = Number(initialParams.get("share")) || null;
      let topicId = Number(initialParams.get("topic")) || null;
      if (shareId) {
        try {
          const resp = await ShareDataService.get(shareId);
          topicId = resp.data.shareTopicId;
          setSelected({ topicId, shareId, view: "share" });
        } catch (e) {
          setMessage("该分享不存在或已被删除。");
        }
      } else if (topicId) {
        setSelected({ topicId, shareId: null, view: "topic" });
      }
      if (topicId) setExpandedTopics((prev) => ({ ...prev, [topicId]: true }));
      setIsLoading(false);
    })();
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtersActive = !!(filterTopicId || filterTeacherName.trim() || filterSchoolName);

  const filteredShares = useMemo(() => {
    if (!allShares) return [];
    const teacherQuery = filterTeacherName.trim().toLowerCase();
    const schoolQuery = filterSchoolName.trim().toLowerCase();
    return allShares.filter(
      (s) =>
        (!filterTopicId || String(s.shareTopicId) === filterTopicId) &&
        (!teacherQuery || authorName(s).toLowerCase().includes(teacherQuery)) &&
        (!schoolQuery || schoolNameOf(s).toLowerCase().includes(schoolQuery))
    );
  }, [allShares, filterTopicId, filterTeacherName, filterSchoolName]);

  const sharesByTopic = useMemo(() => {
    const byTopic = {};
    for (const s of filteredShares) (byTopic[s.shareTopicId] = byTopic[s.shareTopicId] || []).push(s);
    return byTopic;
  }, [filteredShares]);

  // Unfiltered, the tree lists every 话题 (an empty one is still where the
  // next share goes); filtered, only those with a matching share -- or the
  // one picked in the 话题 filter, even if nothing under it matches.
  const visibleTopics = useMemo(
    () =>
      filtersActive
        ? topics.filter((t) => (filterTopicId ? String(t.id) === filterTopicId : sharesByTopic[t.id]))
        : topics,
    [topics, filtersActive, filterTopicId, sharesByTopic]
  );

  // Matches would otherwise sit inside collapsed 话题 -- open every 话题 that
  // has one whenever the filters change.
  useEffect(() => {
    if (!filtersActive) return;
    setExpandedTopics((prev) => {
      const next = { ...prev };
      Object.keys(sharesByTopic).forEach((id) => {
        next[id] = true;
      });
      if (filterTopicId) next[filterTopicId] = true;
      return next;
    });
  }, [filtersActive, filterTopicId, sharesByTopic]);

  // Only schools with at least one share -- the rest would be dead-end picks
  // (same narrowing as plans-hierarchy.component.js's schoolOptions).
  const schoolOptions = useMemo(() => {
    const codes = new Set(
      (allShares || []).map((s) => s.Author && s.Author.School && String(s.Author.School.code)).filter(Boolean)
    );
    return SCHOOLS.filter((s) => codes.has(String(s.code))).map((s) => ({ value: s.code, label: s.name, address: s.address }));
  }, [allShares]);

  // Filters + selection in the URL (history.replace, so typing doesn't pile
  // up entries). Starts from history.location to keep explorer-pane.js's
  // ?pane=content entry and its state -- see plans-hierarchy.component.js.
  useEffect(() => {
    if (isLoading) return;
    const current = history.location;
    const params = new URLSearchParams(current.search || "");
    const setOrDelete = (key, value) => (value ? params.set(key, value) : params.delete(key));
    setOrDelete("topicFilter", filterTopicId);
    setOrDelete("teacherName", filterTeacherName);
    setOrDelete("schoolName", filterSchoolName);
    setOrDelete("topic", selected.view === "share" ? "" : selected.topicId ? String(selected.topicId) : "");
    setOrDelete("share", selected.view === "share" && selected.shareId ? String(selected.shareId) : "");
    const nextSearch = params.toString();
    if (nextSearch !== (current.search || "").replace(/^\?/, "")) {
      history.replace({ pathname: current.pathname, search: nextSearch, state: current.state });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, filterTopicId, filterTeacherName, filterSchoolName, selected]);

  const clearFilters = () => {
    setFilterTopicId("");
    setFilterTeacherName("");
    setFilterSchoolName("");
  };

  const retrieveShare = useCallback(async (shareId) => {
    setIsLoadingShare(true);
    try {
      const resp = await ShareDataService.get(shareId);
      setShare(resp.data);
    } catch (e) {
      setShare(null);
      setMessage(e?.response?.data?.message || "加载分享失败。");
    } finally {
      setIsLoadingShare(false);
    }
  }, []);

  useEffect(() => {
    setIsEditingShare(false);
    if (selected.view === "share" && selected.shareId) retrieveShare(selected.shareId);
  }, [selected.view, selected.shareId, retrieveShare]);

  const selectedTopic = useMemo(() => topics.find((t) => t.id === selected.topicId) || null, [topics, selected.topicId]);

  const toggleTopic = (topicId) => setExpandedTopics((prev) => ({ ...prev, [topicId]: !prev[topicId] }));

  const select = (topicId, view, shareId = null) => {
    setMessage("");
    setSelected({ topicId, shareId, view });
  };

  // Refreshes everything a share change touches: the 话题 counts (which
  // also drive the lock) and the share list.
  const refreshAfterShareChange = async () => {
    await Promise.all([retrieveTopics(), retrieveShares()]);
  };

  // ---- 话题 (admin) ----

  const submitCreateTopic = async (e) => {
    e.preventDefault();
    if (!topicForm.title.trim()) {
      setMessage("请填写话题名称。");
      return;
    }
    try {
      const resp = await ShareTopicDataService.create(topicForm);
      setIsCreatingTopic(false);
      setTopicForm(EMPTY_TOPIC_FORM);
      await retrieveTopics();
      setExpandedTopics((prev) => ({ ...prev, [resp.data.id]: true }));
      select(resp.data.id, "topic");
    } catch (err) {
      setMessage(err?.response?.data?.message || "创建话题失败。");
    }
  };

  const startEditTopic = (topic) => {
    setEditingTopicId(topic.id);
    setTopicForm({ title: topic.title, description: topic.description || "" });
    select(topic.id, "topic");
  };

  const submitEditTopic = async (e) => {
    e.preventDefault();
    setBusyTopicId(editingTopicId);
    try {
      await ShareTopicDataService.update(editingTopicId, topicForm);
      setEditingTopicId(null);
      setTopicForm(EMPTY_TOPIC_FORM);
      await retrieveTopics();
    } catch (err) {
      setMessage(err?.response?.data?.message || "修改话题失败。");
      await retrieveTopics();
    } finally {
      setBusyTopicId(null);
    }
  };

  const deleteTopic = async (topic) => {
    if (!window.confirm(`确定删除话题「${topic.title}」吗？`)) return;
    setBusyTopicId(topic.id);
    try {
      await ShareTopicDataService.delete(topic.id);
      if (selected.topicId === topic.id) setSelected({ topicId: null, shareId: null, view: null });
      setMessage("话题已删除。");
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除话题失败。");
    } finally {
      await retrieveTopics();
      setBusyTopicId(null);
    }
  };

  // ---- 分享 ----

  const loadPlanOptions = async (input) => {
    // A teacher picks among their own courses; an admin among the chosen
    // author's (or every course, before an author is picked).
    const params = { keyword: input || undefined, size: 30 };
    if (!isAdmin) params.mine = true;
    else if (shareForm.author) params.teacherId = shareForm.author.value;
    try {
      const resp = await PlanDataService.getAll(params);
      return (resp.data.rows || []).map(planOption);
    } catch (e) {
      return [];
    }
  };

  const startCreateShare = (topicId) => {
    setShareForm(EMPTY_SHARE_FORM);
    select(topicId, "create");
  };

  const loadTeacherOptions = async (input) => {
    try {
      const resp = await ShareDataService.getTeachers(input || undefined);
      return (resp.data || []).map(teacherOption);
    } catch (e) {
      return [];
    }
  };

  const startEditShare = () => {
    setShareForm({
      title: share.title,
      summary: share.summary || "",
      relatedPlan: planOption(share.RelatedPlan),
      author: teacherOption(share.Author),
    });
    setIsEditingShare(true);
  };

  const shareFormPayload = () => ({
    title: shareForm.title,
    summary: shareForm.summary,
    relatedPlanId: shareForm.relatedPlan ? shareForm.relatedPlan.value : null,
    ...(isAdmin && shareForm.author ? { authorId: shareForm.author.value } : {}),
  });

  const submitCreateShare = async (e) => {
    e.preventDefault();
    if (!shareForm.title.trim()) {
      setMessage("请填写分享标题。");
      return;
    }
    if (isAdmin && !shareForm.author) {
      setMessage("请选择分享的作者教师。");
      return;
    }
    setIsSaving(true);
    try {
      const resp = await ShareDataService.create({ ...shareFormPayload(), shareTopicId: selected.topicId });
      await refreshAfterShareChange();
      setExpandedTopics((prev) => ({ ...prev, [selected.topicId]: true }));
      select(selected.topicId, "share", resp.data.id);
      setMessage("分享已发布，可在下方「分享内容」中上传 Word 文档、课件等文件。");
    } catch (err) {
      setMessage(err?.response?.data?.message || "发布分享失败。");
    } finally {
      setIsSaving(false);
    }
  };

  const submitEditShare = async (e) => {
    e.preventDefault();
    if (!shareForm.title.trim()) {
      setMessage("请填写分享标题。");
      return;
    }
    setIsSaving(true);
    try {
      await ShareDataService.update(share.id, shareFormPayload());
      setIsEditingShare(false);
      await Promise.all([retrieveShare(share.id), retrieveShares()]);
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存分享失败。");
    } finally {
      setIsSaving(false);
    }
  };

  const deleteShare = async () => {
    if (!window.confirm("此操作将永久删除该分享及其所有文件，且无法撤销。确定继续吗？")) return;
    try {
      await ShareDataService.delete(share.id);
      const topicId = share.shareTopicId;
      setShare(null);
      await refreshAfterShareChange();
      select(topicId, "topic");
      setMessage("分享已删除。");
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除分享失败。");
    }
  };

  // ---- rendering ----

  const renderShareForm = (onSubmit, submitLabel, onCancel) => (
    <form onSubmit={onSubmit}>
      {isAdmin && (
        <div className="form-group">
          <label htmlFor="shareAuthor">作者教师</label>
          <AsyncSelect
            inputId="shareAuthor"
            cacheOptions
            defaultOptions
            loadOptions={loadTeacherOptions}
            value={shareForm.author}
            placeholder="输入教师姓名搜索..."
            noOptionsMessage={() => "没有找到教师"}
            loadingMessage={() => "加载中..."}
            // The related course belongs to the author -- a different
            // author's courses are a different list.
            onChange={(option) =>
              setShareForm((prev) => ({
                ...prev,
                author: option,
                relatedPlan: prev.author && option && prev.author.value === option.value ? prev.relatedPlan : null,
              }))
            }
          />
        </div>
      )}
      <div className="form-group">
        <label>标题</label>
        <input
          type="text"
          className="form-control"
          maxLength={255}
          placeholder="如：《黄陂三鲜》让孩子重新认识了家乡"
          value={shareForm.title}
          onChange={(e) => {
            const value = e.target.value;
            setShareForm((prev) => ({ ...prev, title: value }));
          }}
        />
      </div>
      <div className="form-group">
        <label>简介</label>
        <textarea
          className="form-control"
          rows={4}
          placeholder="简要说明您的观点或经验（可选）"
          value={shareForm.summary}
          onChange={(e) => {
            const value = e.target.value;
            setShareForm((prev) => ({ ...prev, summary: value }));
          }}
        />
      </div>
      <div className="form-group">
        <label>关联课程（可选）</label>
        <AsyncSelect
          key={shareForm.author ? shareForm.author.value : "none"}
          cacheOptions
          defaultOptions
          isClearable
          loadOptions={loadPlanOptions}
          value={shareForm.relatedPlan}
          placeholder={isAdmin ? "选择作者教师的一门乡土课程..." : "选择您的一门乡土课程..."}
          noOptionsMessage={() => "没有找到课程"}
          loadingMessage={() => "加载中..."}
          onChange={(option) => setShareForm((prev) => ({ ...prev, relatedPlan: option }))}
        />
      </div>
      <button type="submit" className="btn btn-primary mr-2" disabled={isSaving}>
        {isSaving ? "保存中..." : submitLabel}
      </button>
      <button type="button" className="btn btn-secondary" onClick={onCancel}>
        取消
      </button>
    </form>
  );

  const renderTopicForm = (onSubmit, submitLabel, onCancel, compact) => (
    <form onSubmit={onSubmit} className={compact ? "pl-fm-new-folder-form mb-2" : ""}>
      <textarea
        className={`form-control ${compact ? "form-control-sm mb-1" : "mb-2"}`}
        placeholder="话题名称，如：一堂乡土课程带来的影响"
        autoFocus
        rows={2}
        maxLength={255}
        value={topicForm.title}
        onChange={(e) => {
          const value = e.target.value;
          setTopicForm((prev) => ({ ...prev, title: value }));
        }}
      />
      <textarea
        className={`form-control ${compact ? "form-control-sm mb-1" : "mb-2"}`}
        placeholder="话题说明（可选）"
        rows={compact ? 2 : 4}
        value={topicForm.description}
        onChange={(e) => {
          const value = e.target.value;
          setTopicForm((prev) => ({ ...prev, description: value }));
        }}
      />
      <button type="submit" className="btn btn-sm btn-primary mr-2" disabled={!!busyTopicId}>
        {submitLabel}
      </button>
      <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>
        取消
      </button>
    </form>
  );

  const renderTopicView = () => {
    if (!selectedTopic) return <div className="pl-empty">话题不存在。</div>;
    const shares = allShares ? sharesByTopic[selectedTopic.id] || [] : null;
    const locked = selectedTopic.shareCount > 0;
    return (
      <>
        <div className="pl-card mb-3">
          {editingTopicId === selectedTopic.id ? (
            renderTopicForm(submitEditTopic, "保存", () => {
              setEditingTopicId(null);
              setTopicForm(EMPTY_TOPIC_FORM);
            })
          ) : (
            <>
              <h5 className="mb-2">{selectedTopic.title}</h5>
              {selectedTopic.description && <p className="mb-2" style={{ whiteSpace: "pre-wrap" }}>{selectedTopic.description}</p>}
              <div className="d-flex flex-wrap justify-content-between align-items-center">
                <span className="text-muted" style={{ fontSize: "0.85em" }}>
                  共 {selectedTopic.shareCount} 条分享
                  {filtersActive && `，符合筛选条件 ${shares ? shares.length : 0} 条`}
                  {isAdmin && locked && ` · ${LOCKED_TITLE}`}
                </span>
                <div>
                  {isAdmin && !locked && (
                    <>
                      <button type="button" className="btn btn-sm btn-outline-secondary mr-2" onClick={() => startEditTopic(selectedTopic)}>
                        修改话题
                      </button>
                      <button type="button" className="btn btn-sm btn-outline-danger mr-2" onClick={() => deleteTopic(selectedTopic)}>
                        删除话题
                      </button>
                    </>
                  )}
                  {canShare && (
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => startCreateShare(selectedTopic.id)}>
                      <i className={`fas fa-${isAdmin ? "upload" : "plus"} mr-1`}></i>
                      {shareActionLabel}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {!shares ? (
          <div className="pl-empty">加载中...</div>
        ) : shares.length === 0 ? (
          <div className="pl-empty">{filtersActive ? "该话题下没有符合筛选条件的分享。" : "该话题下暂无分享。"}</div>
        ) : (
          <div className="pl-plan-grid">
            {shares.map((s) => (
              <div className="pl-plan-card" key={s.id}>
                <h6 className="pl-plan-card-title">{s.title}</h6>
                {s.summary && (
                  <p className="text-muted mb-0" style={{ fontSize: "0.9em", whiteSpace: "pre-wrap" }}>
                    {s.summary.length > 80 ? `${s.summary.slice(0, 80)}…` : s.summary}
                  </p>
                )}
                <div className="pl-plan-card-meta">
                  <span>
                    <i className="fas fa-user"></i> {authorLabel(s)}
                  </span>
                  <span>
                    <i className="fas fa-calendar-alt"></i> {formatDate(s.createdAt)}
                  </span>
                </div>
                {s.RelatedPlan && (
                  <div className="pl-plan-card-meta">
                    <span>
                      <i className="fas fa-book"></i> {s.RelatedPlan.title}
                    </span>
                  </div>
                )}
                <div className="pl-plan-card-footer">
                  <button type="button" className="btn btn-link p-0" onClick={() => select(s.shareTopicId, "share", s.id)}>
                    查看分享
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  const renderShareView = () => {
    if (isLoadingShare || !share || share.id !== selected.shareId) {
      return <div className="pl-empty">{isLoadingShare ? "加载中..." : "分享不存在。"}</div>;
    }
    return (
      <>
        <div className="pl-card mb-3">
          {isEditingShare ? (
            renderShareForm(submitEditShare, "保存", () => setIsEditingShare(false))
          ) : (
            <>
              <div className="text-muted mb-1" style={{ fontSize: "0.85em" }}>
                话题：
                <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={() => select(share.shareTopicId, "topic")}>
                  {share.Topic ? share.Topic.title : "-"}
                </button>
              </div>
              <h5 className="mb-2">{share.title}</h5>
              <div className="pl-plan-card-meta mb-2">
                <span>
                  <i className="fas fa-user"></i> {authorLabel(share)}
                </span>
                <span>
                  <i className="fas fa-calendar-alt"></i> 发布于 {formatDate(share.createdAt)}
                </span>
                {share.RelatedPlan && (
                  <span>
                    <i className="fas fa-book"></i> 关联课程：
                    <Link to={`/plans/${share.RelatedPlan.id}`}>{share.RelatedPlan.title}</Link>
                  </span>
                )}
              </div>
              {share.summary && <p style={{ whiteSpace: "pre-wrap" }}>{share.summary}</p>}
              {share.canEdit && (
                <div className="d-flex justify-content-between">
                  <button type="button" className="btn btn-sm btn-outline-secondary" onClick={startEditShare}>
                    编辑
                  </button>
                  <button type="button" className="btn btn-sm btn-outline-danger" onClick={deleteShare}>
                    删除本分享
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <h6 className="pl-section-title">分享内容</h6>
        <LessonFileManager
          planId={share.id}
          lessonIndex={null}
          canEdit={!!share.canEdit}
          canDownload
          folderService={ShareFolderDataService}
          artifactService={ShareArtifactDataService}
          docCategoryLabel="Word文档"
          downloadUrlBase="/api/share-artifacts"
        />
      </>
    );
  };

  const renderCreateView = () => (
    <div className="pl-card">
      <div className="text-muted mb-2" style={{ fontSize: "0.85em" }}>
        话题：{selectedTopic ? selectedTopic.title : "-"}
      </div>
      <h5 className="mb-3">{shareActionLabel}</h5>
      {renderShareForm(submitCreateShare, "发布", () => select(selected.topicId, "topic"))}
      <div className="text-muted mt-2" style={{ fontSize: "0.85em" }}>发布后即可上传 Word 文档、课件 PPT、图片、视频等文件。</div>
    </div>
  );

  const renderContent = () => {
    if (selected.view === "topic") return renderTopicView();
    if (selected.view === "share") return renderShareView();
    if (selected.view === "create") return renderCreateView();
    return <div className="pl-empty">请选择左侧话题。</div>;
  };

  if (!isLogin) {
    return (
      <div className="container pl-page">
        <div className="pl-empty">
          请先<Link to="/login">登录</Link>后查看教师分享。
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container pl-page">
        <div className="pl-empty">加载中...</div>
      </div>
    );
  }

  const paneLabel =
    selected.view === "share" && share
      ? share.title
      : selected.view === "create"
      ? shareActionLabel
      : selectedTopic
      ? selectedTopic.title
      : "选择话题";

  return (
    <div className="container pl-page">
      <div className="pl-hero">
        <h4 className="pl-title">教师分享</h4>
        <p className="pl-subtitle mb-0">围绕管理员设定的话题，分享您在乡土课程实践中的观点与经验。</p>
      </div>

      <div className="form-row">
        <div className="form-group col-md-4">
          <label htmlFor="shareTopicFilter">话题筛选</label>
          <select
            id="shareTopicFilter"
            className="form-control"
            value={filterTopicId}
            onChange={(e) => setFilterTopicId(e.target.value)}
          >
            <option value="">全部话题</option>
            {topics.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.title}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group col-md-4">
          <label htmlFor="shareTeacherFilter">教师姓名筛选</label>
          <input
            id="shareTeacherFilter"
            className="form-control"
            placeholder="按教师姓名搜索"
            value={filterTeacherName}
            onChange={(e) => setFilterTeacherName(e.target.value)}
          />
        </div>
        <div className="form-group col-md-4">
          <label htmlFor="shareSchoolFilter">学校名称筛选</label>
          <Select
            inputId="shareSchoolFilter"
            options={schoolOptions}
            value={schoolOptions.find((o) => o.label === filterSchoolName) || null}
            onChange={(option) => setFilterSchoolName(option ? option.label : "")}
            placeholder="搜索并选择学校（支持名称/代码）..."
            formatOptionLabel={formatSchoolOptionLabel}
            filterOption={schoolFilterOption}
            noOptionsMessage={() => "没有已发布分享的学校"}
            isClearable
          />
        </div>
      </div>
      {filtersActive && (
        <div className="mb-3 text-muted" style={{ fontSize: "0.9em" }}>
          找到 {filteredShares.length} 条分享
          <button type="button" className="btn btn-link btn-sm py-0" onClick={clearFilters}>
            清除筛选
          </button>
        </div>
      )}

      <div className={`pl-explorer ${pane.className}`}>
        <button
          type="button"
          className="pl-explorer-hide-toggle"
          onClick={() => setNavCollapsed((prev) => !prev)}
          title={navCollapsed ? "显示导航" : "隐藏导航"}
        >
          <i className={`fas fa-${navCollapsed ? "angle-double-right" : "angle-double-left"}`}></i>
        </button>

        {!navCollapsed && (
          <div className="pl-explorer-nav" onClick={pane.onNavClick}>
            {isAdmin && !isCreatingTopic && (
              <button
                type="button"
                className="btn btn-sm btn-outline-primary mb-2"
                onClick={() => {
                  setEditingTopicId(null);
                  setTopicForm(EMPTY_TOPIC_FORM);
                  setIsCreatingTopic(true);
                }}
              >
                <i className="fas fa-plus mr-1"></i>新建话题
              </button>
            )}
            {isAdmin &&
              isCreatingTopic &&
              renderTopicForm(
                submitCreateTopic,
                "创建",
                () => {
                  setIsCreatingTopic(false);
                  setTopicForm(EMPTY_TOPIC_FORM);
                },
                true
              )}

            {topics.length === 0 && <div className="pl-explorer-empty">暂无分享话题。</div>}
            {topics.length > 0 && visibleTopics.length === 0 && <div className="pl-explorer-empty">没有符合条件的分享。</div>}

            {visibleTopics.map((topic) => {
              const locked = topic.shareCount > 0;
              const shares = sharesByTopic[topic.id] || [];
              return (
                <div className="pl-explorer-group" key={topic.id}>
                  <div className="pl-explorer-row">
                    <button type="button" className="pl-explorer-folder pl-explorer-row-main" onClick={() => toggleTopic(topic.id)}>
                      <i className={`fas fa-chevron-${expandedTopics[topic.id] ? "down" : "right"} pl-explorer-chevron`}></i>
                      <i className="fas fa-comments pl-folder-icon mr-1"></i> {topic.title}
                      <span className="text-muted ml-1">({filtersActive ? `${shares.length}/${topic.shareCount}` : topic.shareCount})</span>
                    </button>
                    {busyTopicId === topic.id && (
                      <span className="pl-explorer-row-actions pl-explorer-row-actions-busy">
                        <span className="spinner-border spinner-border-sm pl-explorer-row-spinner" role="status"></span>
                      </span>
                    )}
                    {isAdmin && busyTopicId !== topic.id && !locked && (
                      <span className="pl-explorer-row-actions">
                        <button
                          type="button"
                          className="pl-explorer-row-action"
                          title="修改"
                          data-explorer-leaf
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditTopic(topic);
                          }}
                        >
                          <i className="fas fa-pencil-alt"></i>
                        </button>
                        <button
                          type="button"
                          className="pl-explorer-row-action"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteTopic(topic);
                          }}
                        >
                          <i className="fas fa-trash-alt"></i>
                        </button>
                      </span>
                    )}
                  </div>
                  {expandedTopics[topic.id] && (
                    <div className="pl-explorer-children">
                      <button
                        type="button"
                        className={`pl-explorer-leaf ${selected.topicId === topic.id && selected.view === "topic" ? "is-active" : ""}`}
                        onClick={() => select(topic.id, "topic")}
                      >
                        <i className="fas fa-th-large mr-1"></i>全部分享
                      </button>
                      {shares.map((s) => (
                        <button
                          type="button"
                          key={s.id}
                          className={`pl-explorer-leaf ${selected.view === "share" && selected.shareId === s.id ? "is-active" : ""}`}
                          onClick={() => select(topic.id, "share", s.id)}
                          title={`${s.title} -- ${authorLabel(s)}`}
                        >
                          {s.title}
                          <span className="text-muted ml-1">· {s.Author ? s.Author.chineseName || s.Author.username : ""}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="pl-explorer-content">
          <ExplorerPaneBar label={paneLabel} onBack={pane.openNav} />
          {message && <div className="alert alert-info py-2">{message}</div>}
          {renderContent()}
        </div>
      </div>
    </div>
  );
};

export default TeacherShare;
