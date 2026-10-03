import React, { useCallback, useEffect, useMemo, useState } from "react";
import CreatableSelect from "react-select/creatable";
import mammoth from "mammoth/mammoth.browser";

import MaterialTopicDataService from "../services/material-topic.service";
import MaterialLinkDataService from "../services/material-link.service";
import MaterialFolderDataService from "../services/material-folder.service";
import MaterialArtifactDataService from "../services/material-artifact.service";
import TeacherManualDataService from "../services/teacher-manual.service";
import AuthService from "../services/auth.service";
import LessonFileManager from "./lesson-file-manager.component";
import KnowledgeIndex from "./knowledge-index.component";
import "../curriculum.css";

// Mirrors backend/app/constants/materialCategories.js's MANUAL_CATEGORY/
// MANUAL_THEME -- 使用指南 is an ordinary category an admin can file any
// "how to use the system" topic under (each behaving exactly like any other
// topic: normal tabs, normal knowledge-base ingestion feeding 欣欣助手/AI 点评
// -- see teacherManual.controller.js#publish's own comment on the "学习资源库
// is the single source of truth" design). The one specific topic these two
// constants identify together -- the auto-generated manual, created by the
// "教师手册" admin card below -- is the sole exception: it gets a plain
// read-only "在线手册" reading view instead of the usual 基本信息/材料内容/
// 视频链接/知识卡片 tab set (see isManualTopic/renderManualViewer below),
// since it's meant to be read like a web page, not managed like a file
// library. Any *other* topic filed under 使用指南 (e.g. a hand-written
// "使用说明") gets the normal tab set, same as any other category.
const MANUAL_CATEGORY = "使用指南";
const MANUAL_THEME = "教师手册";
const isManualTopic = (topic) => !!topic && topic.category === MANUAL_CATEGORY && topic.theme === MANUAL_THEME;
// Neither the 使用指南 folder nor the manual topic itself can be renamed --
// publish finds the manual by that exact pair (enforced server-side in
// material-topic.controller.js too), so their 重命名 pencils are hidden.
// Delete stays: the next 生成并发布 recreates both.

// 学习资源库 -- a Category -> Theme(主题/Event) tree, laid out like
// plan-detail.component.js's own explorer (left nav tree, right content
// pane). Purely admin-curated (unlike Plan's teacher ownership): admins
// create/edit/delete every Theme and its contents, teachers/experts only
// browse/download -- no draft/submitted workflow, no owner concept at all.
// "material contents" reuses lesson-file-manager.component.js's mini cloud
// file system, scoped by materialTopicId instead of (planId, lessonIndex)
// via the material-folder.service.js/material-artifact.service.js pair (see
// that component's folderService/artifactService props).
//
// The tree's first-level folder is `category` -- free-form admin text (a
// year like "2026", a program name, anything), not its own table: it's
// purely "every topic sharing this same category value groups under one
// folder" (see topicsByCategory below), same "field, not a table" shape
// material-topic.controller.js's own comments describe. Renaming/deleting
// that folder (renameCategory/deleteCategoryByValue below) is therefore a
// bulk update/delete across every topic currently in that group, not an
// operation on a folder row of its own.
const EMPTY_TOPIC_FORM = { category: "", theme: "", lecturer: "", comment: "" };
const EMPTY_LINK_FORM = { description: "", url: "" };

const MaterialsLibrary = () => {
  const isAdmin = AuthService.isAdmin();
  const isTeacher = AuthService.isTeacher();
  const isExpert = AuthService.isExpert();
  const canDownload = isAdmin || isTeacher || isExpert;

  const [topics, setTopics] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [manualBusy, setManualBusy] = useState(""); // "" | "download" | "publish"
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState({});
  const [expandedTopics, setExpandedTopics] = useState({});
  const [selected, setSelected] = useState({ topicId: null, key: null });

  const [isCreatingTopic, setIsCreatingTopic] = useState(false);
  const [newTopicForm, setNewTopicForm] = useState(EMPTY_TOPIC_FORM);

  const [renamingTopicId, setRenamingTopicId] = useState(null);
  const [renameTopicValue, setRenameTopicValue] = useState("");
  // Topic currently mid rename-save or delete -- both round-trip through
  // retrieveTopics() afterwards (a full topics reload, not just the one
  // row), which is noticeably slower than a typical click, hence a visible
  // spinner rather than just disabling the row silently.
  const [busyTopicId, setBusyTopicId] = useState(null);

  // Same rename/busy pattern as the topic-level state just above, but for
  // the first-level category folder -- renamingCategory/busyCategory hold
  // the *original* category value (its identity for the bulk update/delete
  // call), not an id, since a category is just a shared text field, not a
  // row of its own.
  const [renamingCategory, setRenamingCategory] = useState(null);
  const [renameCategoryValue, setRenameCategoryValue] = useState("");
  const [busyCategory, setBusyCategory] = useState(null);

  const [metaForm, setMetaForm] = useState(null);
  const [metaDirty, setMetaDirty] = useState(false);
  const [isRegeneratingSkill, setIsRegeneratingSkill] = useState(false);

  const [links, setLinks] = useState([]);
  const [isLoadingLinks, setIsLoadingLinks] = useState(false);
  const [isAddingLink, setIsAddingLink] = useState(false);
  const [newLinkForm, setNewLinkForm] = useState(EMPTY_LINK_FORM);
  const [editingLinkId, setEditingLinkId] = useState(null);
  const [editLinkForm, setEditLinkForm] = useState(EMPTY_LINK_FORM);

  const [skillCard, setSkillCard] = useState(null); // null = none generated yet
  const [isLoadingSkill, setIsLoadingSkill] = useState(false);
  const [skillForm, setSkillForm] = useState(null);
  const [skillDirty, setSkillDirty] = useState(false);
  const [isSkillGenerating, setIsSkillGenerating] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null); // null = no search run yet
  const [isSearching, setIsSearching] = useState(false);

  // 在线手册 (manual-viewer) state -- see renderManualViewer/retrieveManual.
  const [manualHtml, setManualHtml] = useState(null);
  const [manualArtifact, setManualArtifact] = useState(null);
  const [isLoadingManualDoc, setIsLoadingManualDoc] = useState(false);
  const [manualLoadError, setManualLoadError] = useState("");

  const retrieveTopics = useCallback(async () => {
    setIsLoading(true);
    try {
      const resp = await MaterialTopicDataService.getAll();
      setTopics(Array.isArray(resp.data) ? resp.data : []);
    } catch (e) {
      console.log(e);
      setMessage("加载学习资源库失败。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    retrieveTopics();
  }, [retrieveTopics]);

  // Streams the always-freshly-generated .docx straight to the browser --
  // same blob/object-URL pattern as plans-list.component.js's
  // downloadTemplateFile, since this is a raw arraybuffer response, not a
  // navigable URL.
  const downloadTeacherManual = async () => {
    setManualBusy("download");
    setMessage("");
    try {
      const resp = await TeacherManualDataService.download();
      const url = window.URL.createObjectURL(
        new Blob([resp.data], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "教师使用手册.docx");
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setMessage(err?.response?.data?.message || "教师手册下载失败。");
    } finally {
      setManualBusy("");
    }
  };

  // Publishing files/updates the 使用指南/教师手册 topic below -- reload the tree
  // afterward so a first-time publish's brand-new topic (or an updated
  // artifact size/timestamp on a republish) shows up without a manual
  // page refresh.
  const publishTeacherManual = async () => {
    setManualBusy("publish");
    setMessage("");
    try {
      const resp = await TeacherManualDataService.publish();
      setMessage((resp.data && resp.data.message) || "教师手册已发布。");
      await retrieveTopics();
    } catch (err) {
      setMessage(err?.response?.data?.message || "教师手册发布失败。");
    } finally {
      setManualBusy("");
    }
  };

  const selectedTopic = useMemo(
    () => topics.find((t) => t.id === selected.topicId) || null,
    [topics, selected.topicId]
  );

  useEffect(() => {
    if (selected.key === "basic" && selectedTopic) {
      setMetaForm({
        category: selectedTopic.category,
        theme: selectedTopic.theme || "",
        lecturer: selectedTopic.lecturer || "",
        comment: selectedTopic.comment || "",
      });
      setMetaDirty(false);
    }
  }, [selected.key, selectedTopic]);

  const retrieveLinks = useCallback(async (topicId) => {
    setIsLoadingLinks(true);
    try {
      const resp = await MaterialLinkDataService.getByTopic(topicId);
      setLinks(Array.isArray(resp.data) ? resp.data : []);
    } catch (e) {
      console.log(e);
      setMessage("加载视频链接失败。");
    } finally {
      setIsLoadingLinks(false);
    }
  }, []);

  useEffect(() => {
    if (selected.key === "links" && selected.topicId) {
      retrieveLinks(selected.topicId);
    }
  }, [selected.key, selected.topicId, retrieveLinks]);

  const retrieveSkill = useCallback(async (topicId) => {
    setIsLoadingSkill(true);
    try {
      const resp = await MaterialTopicDataService.getSkill(topicId);
      setSkillCard(resp.data || null);
      setSkillForm({
        title: (resp.data && resp.data.title) || "",
        summary: (resp.data && resp.data.summary) || "",
        keyPointsText: (resp.data && resp.data.keyPoints ? resp.data.keyPoints : []).join("\n"),
        tagsText: (resp.data && resp.data.tags ? resp.data.tags : []).join("、"),
      });
      setSkillDirty(false);
    } catch (e) {
      console.log(e);
      setMessage("加载知识卡片失败。");
    } finally {
      setIsLoadingSkill(false);
    }
  }, []);

  useEffect(() => {
    if (selected.key === "skill" && selected.topicId) {
      retrieveSkill(selected.topicId);
    }
  }, [selected.key, selected.topicId, retrieveSkill]);

  // While viewing 知识卡片, poll whether this topic's card is currently being
  // (re)generated -- covers every trigger (基本信息 save, link add/edit, an
  // upload's own background regeneration, or the 强制生成 button on 基本信息),
  // not just a force-click made from this tab, since knowledgeIngest.js's
  // generatingCounts is shared across all of them. On the true -> false edge
  // (generation just finished), re-fetch the card so the freshly generated
  // content shows without the admin having to manually refresh.
  useEffect(() => {
    if (selected.key !== "skill" || !selected.topicId) {
      setIsSkillGenerating(false);
      return undefined;
    }
    const topicId = selected.topicId;
    let cancelled = false;
    let wasGenerating = false;
    const poll = async () => {
      try {
        const resp = await MaterialTopicDataService.getSkillGenerating(topicId);
        if (cancelled) return;
        const generating = !!(resp.data && resp.data.generating);
        setIsSkillGenerating(generating);
        if (wasGenerating && !generating) {
          await retrieveSkill(topicId);
        }
        wasGenerating = generating;
      } catch (e) {
        // Non-critical -- just skip this tick and try again on the next poll.
      }
    };
    poll();
    const intervalId = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [selected.key, selected.topicId, retrieveSkill]);

  // 在线手册 viewer: fetches the manual topic's one artifact (the
  // generated .docx -- see teacherManual.controller.js#publish) and converts
  // it to HTML client-side via mammoth, same conversion plan-detail.
  // component.js's own 预览 button uses, just rendered inline in the page
  // instead of opened in a new tab -- this is meant to read like a web page,
  // not a downloadable file. Picks the most-recently-updated artifact if a
  // topic somehow ends up with more than one (shouldn't normally happen --
  // #publish always overwrites the same row -- but stays correct either way
  // rather than assuming array order).
  const retrieveManual = useCallback(async (topicId) => {
    setIsLoadingManualDoc(true);
    setManualLoadError("");
    setManualHtml(null);
    try {
      const listResp = await MaterialArtifactDataService.getByPlan(topicId);
      const artifacts = Array.isArray(listResp.data) ? listResp.data : [];
      const doc =
        artifacts
          .filter((a) => a.type === "docx")
          .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0] || null;
      setManualArtifact(doc);
      if (!doc) {
        setManualLoadError("本主题下暂无手册文档。");
        return;
      }
      const fileResp = await MaterialArtifactDataService.download(doc.id);
      const result = await mammoth.convertToHtml({ arrayBuffer: fileResp.data });
      setManualHtml(result.value || "");
    } catch (e) {
      console.log(e);
      setManualLoadError("加载手册内容失败。");
    } finally {
      setIsLoadingManualDoc(false);
    }
  }, []);

  useEffect(() => {
    if (selected.key === "manual" && selected.topicId) {
      retrieveManual(selected.topicId);
    }
  }, [selected.key, selected.topicId, retrieveManual]);

  const topicsByCategory = useMemo(() => {
    const byCategory = new Map();
    for (const t of topics) {
      if (!byCategory.has(t.category)) byCategory.set(t.category, []);
      byCategory.get(t.category).push(t);
    }
    // Ascending, locale-aware -- unlike the old numeric-year sort (newest
    // first made sense for a year; it doesn't generalize to arbitrary
    // text), plain A-Z reading order is the least-surprising default for a
    // free-text label.
    return Array.from(byCategory.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh"));
  }, [topics]);

  // react-select/creatable options for every existing category -- lets an
  // admin pick one from the dropdown (create-topic form, or moving an
  // existing topic to a different category in 基本信息) without retyping it
  // exactly, while CreatableSelect's own "create new" affordance still
  // takes free text for a category that doesn't exist yet.
  const categoryOptions = useMemo(
    () => topicsByCategory.map(([category]) => ({ value: category, label: category })),
    [topicsByCategory]
  );

  const toggleCategory = (category) => setExpandedCategories((prev) => ({ ...prev, [category]: !prev[category] }));
  const toggleTopic = (topicId) => setExpandedTopics((prev) => ({ ...prev, [topicId]: !prev[topicId] }));
  const select = (topicId, key) => setSelected({ topicId, key });

  const updateMetaForm = (field, value) => {
    setMetaForm((prev) => ({ ...prev, [field]: value }));
    setMetaDirty(true);
  };

  const saveMeta = async () => {
    try {
      await MaterialTopicDataService.update(selectedTopic.id, metaForm);
      setMetaDirty(false);
      setMessage("基本信息已保存。");
      await retrieveTopics();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存失败。");
    }
  };

  // 强制生成知识卡片: unlike the automatic regeneration fired after every
  // save/upload (which silently no-ops once a card is admin-reviewed or
  // nothing under the topic has changed -- see knowledgeIngest.js), this
  // always calls the LLM and overwrites, reviewed or not. Refreshes the
  // 知识卡片 tab's cached state too, in case it was already loaded, so
  // switching to it shows the new card immediately rather than the stale one.
  const forceRegenerateSkill = async () => {
    if (!selectedTopic) return;
    setIsRegeneratingSkill(true);
    try {
      const resp = await MaterialTopicDataService.regenerateSkill(selectedTopic.id);
      setMessage(resp?.data?.message || "知识卡片已重新生成。");
      if (selected.key === "skill") {
        await retrieveSkill(selectedTopic.id);
      }
    } catch (err) {
      setMessage(err?.response?.data?.message || "生成知识卡片失败。");
    } finally {
      setIsRegeneratingSkill(false);
    }
  };

  // Shared by both the 基本信息 tab's own "删除本主题" button (id implied by
  // selectedTopic) and the tree row's hover delete icon (id passed
  // explicitly, since a topic can be deleted from the tree without ever
  // having been selected/opened).
  const deleteTopicById = async (topicId) => {
    if (!window.confirm("此操作将永久删除该主题及其所有材料内容和链接，且无法撤销。确定继续吗？")) return;
    setBusyTopicId(topicId);
    try {
      await MaterialTopicDataService.delete(topicId, true);
      if (selected.topicId === topicId) setSelected({ topicId: null, key: null });
      setMessage("主题已删除。");
      await retrieveTopics();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    } finally {
      setBusyTopicId(null);
    }
  };

  const startRenameTopic = (topic) => {
    setRenamingTopicId(topic.id);
    setRenameTopicValue(topic.theme || "");
  };

  const cancelRenameTopic = () => {
    setRenamingTopicId(null);
    setRenameTopicValue("");
  };

  const submitRenameTopic = async (topicId) => {
    if (busyTopicId === topicId) return; // already saving (e.g. Enter's onSubmit then the input's own onBlur)
    const theme = renameTopicValue.trim();
    if (!theme) {
      cancelRenameTopic();
      return;
    }
    setBusyTopicId(topicId);
    try {
      await MaterialTopicDataService.update(topicId, { theme });
      cancelRenameTopic();
      await retrieveTopics();
    } catch (err) {
      setMessage(err?.response?.data?.message || "重命名失败。");
    } finally {
      setBusyTopicId(null);
    }
  };

  const submitCreateTopic = async (e) => {
    e.preventDefault();
    if (!newTopicForm.theme.trim() || !newTopicForm.category.trim()) {
      setMessage("请填写分类和主题名称。");
      return;
    }
    try {
      const resp = await MaterialTopicDataService.create(newTopicForm);
      setIsCreatingTopic(false);
      setNewTopicForm(EMPTY_TOPIC_FORM);
      await retrieveTopics();
      setExpandedCategories((prev) => ({ ...prev, [resp.data.category]: true }));
      setExpandedTopics((prev) => ({ ...prev, [resp.data.id]: true }));
      select(resp.data.id, "basic");
    } catch (err) {
      setMessage(err?.response?.data?.message || "创建主题失败。");
    }
  };

  // First-level category folder rename -- bulk-updates every topic
  // currently in `fromCategory` (its identity, since a category is just a
  // shared text field -- see the component's top comment) to the new text.
  // Mirrors startRenameTopic/submitRenameTopic's own inline-edit shape.
  const startRenameCategory = (category) => {
    setRenamingCategory(category);
    setRenameCategoryValue(category);
  };

  const cancelRenameCategory = () => {
    setRenamingCategory(null);
    setRenameCategoryValue("");
  };

  const submitRenameCategory = async (fromCategory) => {
    if (busyCategory === fromCategory) return;
    const to = renameCategoryValue.trim();
    if (!to || to === fromCategory) {
      cancelRenameCategory();
      return;
    }
    setBusyCategory(fromCategory);
    try {
      await MaterialTopicDataService.renameCategory(fromCategory, to);
      cancelRenameCategory();
      // Carry the expanded/collapsed state over to the folder's new key so
      // it doesn't visually collapse just because its identity changed.
      setExpandedCategories((prev) => {
        const next = { ...prev };
        if (fromCategory in next) {
          next[to] = next[fromCategory];
          delete next[fromCategory];
        }
        return next;
      });
      await retrieveTopics();
    } catch (err) {
      setMessage(err?.response?.data?.message || "重命名分类失败。");
    } finally {
      setBusyCategory(null);
    }
  };

  // First-level category folder delete -- bulk-deletes every topic in it
  // (and, transitively, all of their material content/links), same
  // confirm-then-remove shape as deleteTopicById above.
  const deleteCategoryByValue = async (category, topicCount) => {
    if (
      !window.confirm(
        `此操作将永久删除分类「${category}」下的全部 ${topicCount} 个主题及其所有材料内容和链接，且无法撤销。确定继续吗？`
      )
    )
      return;
    setBusyCategory(category);
    try {
      await MaterialTopicDataService.deleteCategory(category, true);
      if (selectedTopic && selectedTopic.category === category) setSelected({ topicId: null, key: null });
      setMessage("分类已删除。");
      await retrieveTopics();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除分类失败。");
    } finally {
      setBusyCategory(null);
    }
  };

  const submitCreateLink = async (e) => {
    e.preventDefault();
    if (!newLinkForm.url.trim()) {
      setMessage("请填写链接地址。");
      return;
    }
    try {
      await MaterialLinkDataService.create(selected.topicId, newLinkForm);
      setIsAddingLink(false);
      setNewLinkForm(EMPTY_LINK_FORM);
      await retrieveLinks(selected.topicId);
    } catch (err) {
      setMessage(err?.response?.data?.message || "添加链接失败。");
    }
  };

  const startEditLink = (link) => {
    setEditingLinkId(link.id);
    setEditLinkForm({ description: link.description || "", url: link.url });
  };

  const saveEditLink = async (e) => {
    e.preventDefault();
    try {
      await MaterialLinkDataService.update(editingLinkId, editLinkForm);
      setEditingLinkId(null);
      await retrieveLinks(selected.topicId);
    } catch (err) {
      setMessage(err?.response?.data?.message || "更新链接失败。");
    }
  };

  const deleteLink = async (id) => {
    if (!window.confirm("确定删除该链接吗？")) return;
    try {
      await MaterialLinkDataService.delete(id);
      await retrieveLinks(selected.topicId);
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除链接失败。");
    }
  };

  const updateSkillForm = (field, value) => {
    setSkillForm((prev) => ({ ...prev, [field]: value }));
    setSkillDirty(true);
  };

  const saveSkill = async () => {
    try {
      await MaterialTopicDataService.updateSkill(selected.topicId, {
        title: skillForm.title,
        summary: skillForm.summary,
        keyPoints: skillForm.keyPointsText.split("\n").map((s) => s.trim()).filter(Boolean),
        tags: skillForm.tagsText.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
      });
      setMessage("知识卡片已保存。");
      await retrieveSkill(selected.topicId);
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存知识卡片失败。");
    }
  };

  const runSearch = async (e) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    setIsSearching(true);
    try {
      const resp = await MaterialTopicDataService.search(q);
      setSearchResults(Array.isArray(resp.data) ? resp.data : []);
    } catch (err) {
      setMessage(err?.response?.data?.message || "搜索失败。");
    } finally {
      setIsSearching(false);
    }
  };

  // Jumps the tree to a search hit's topic (expanding its year/subgroup) and
  // shows its 知识卡片 -- the search matched KB content, so that's the most
  // relevant pane to land on, rather than 基本信息.
  const jumpToSearchResult = (result) => {
    const topic = topics.find((t) => t.id === result.topicId);
    if (!topic) return;
    setExpandedCategories((prev) => ({ ...prev, [topic.category]: true }));
    setExpandedTopics((prev) => ({ ...prev, [topic.id]: true }));
    select(topic.id, "skill");
    setSearchResults(null);
    setSearchQuery("");
  };

  const renderBasicInfo = () => {
    if (!metaForm) return null;
    return (
      <div className="pl-card">
        <div className="form-group">
          <label>分类</label>
          <CreatableSelect
            options={categoryOptions}
            value={metaForm.category ? { value: metaForm.category, label: metaForm.category } : null}
            isDisabled={!isAdmin}
            isClearable={false}
            placeholder="选择或输入新分类..."
            formatCreateLabel={(input) => `新建分类：${input}`}
            onChange={(option) => updateMetaForm("category", option ? option.value : "")}
          />
        </div>
        <div className="form-group">
          <label>主题</label>
          {/* textarea, not a single-line input -- 主题 names here can run
              long, and this keeps the full name visible/wrapped instead of
              scrolling off sideways; overflowY: auto caps growth and scrolls
              internally past maxHeight. */}
          <textarea
            className="form-control"
            rows={2}
            style={{ resize: "vertical", overflowY: "auto", maxHeight: "150px" }}
            value={metaForm.theme}
            disabled={!isAdmin}
            onChange={(e) => updateMetaForm("theme", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>主讲人</label>
          <input
            type="text"
            className="form-control"
            value={metaForm.lecturer}
            disabled={!isAdmin}
            onChange={(e) => updateMetaForm("lecturer", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>备注</label>
          <textarea
            className="form-control"
            rows={4}
            value={metaForm.comment}
            disabled={!isAdmin}
            onChange={(e) => updateMetaForm("comment", e.target.value)}
          />
        </div>
        {isAdmin && (
          <div className="d-flex justify-content-between">
            <div>
              <button type="button" className="btn btn-primary" disabled={!metaDirty} onClick={saveMeta}>
                保存
              </button>
              <button
                type="button"
                className="btn btn-outline-secondary ml-2"
                disabled={isRegeneratingSkill}
                onClick={forceRegenerateSkill}
              >
                {isRegeneratingSkill ? "生成中…" : "强制生成知识卡片"}
              </button>
            </div>
            <button type="button" className="btn btn-outline-danger" onClick={() => deleteTopicById(selectedTopic.id)}>
              删除本主题
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderLinks = () => (
    <div className="pl-card">
      {isLoadingLinks ? (
        <div className="pl-empty">加载中...</div>
      ) : (
        <>
          {links.length === 0 && <div className="pl-empty">暂无视频链接。</div>}
          <ul className="list-group mb-3">
            {links.map((link) =>
              editingLinkId === link.id ? (
                <li className="list-group-item" key={link.id}>
                  <form onSubmit={saveEditLink}>
                    <input
                      type="text"
                      className="form-control mb-2"
                      placeholder="链接描述"
                      value={editLinkForm.description}
                      onChange={(e) => {
                        const value = e.target.value;
                        setEditLinkForm((prev) => ({ ...prev, description: value }));
                      }}
                    />
                    <input
                      type="text"
                      className="form-control mb-2"
                      placeholder="链接地址"
                      value={editLinkForm.url}
                      onChange={(e) => {
                        const value = e.target.value;
                        setEditLinkForm((prev) => ({ ...prev, url: value }));
                      }}
                    />
                    <button type="submit" className="btn btn-sm btn-primary mr-2">
                      保存
                    </button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditingLinkId(null)}>
                      取消
                    </button>
                  </form>
                </li>
              ) : (
                <li className="list-group-item d-flex justify-content-between align-items-center" key={link.id}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.description || link.url}
                  </a>
                  {isAdmin && (
                    <div>
                      <button type="button" className="btn btn-sm btn-link" onClick={() => startEditLink(link)}>
                        编辑
                      </button>
                      <button type="button" className="btn btn-sm btn-link text-danger" onClick={() => deleteLink(link.id)}>
                        删除
                      </button>
                    </div>
                  )}
                </li>
              )
            )}
          </ul>
          {isAdmin && !isAddingLink && (
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setIsAddingLink(true)}>
              <i className="fas fa-plus mr-1"></i>添加链接
            </button>
          )}
          {isAdmin && isAddingLink && (
            <form onSubmit={submitCreateLink} className="mt-2">
              <input
                type="text"
                className="form-control mb-2"
                placeholder="链接描述"
                value={newLinkForm.description}
                onChange={(e) => {
                  const value = e.target.value;
                  setNewLinkForm((prev) => ({ ...prev, description: value }));
                }}
              />
              <input
                type="text"
                className="form-control mb-2"
                placeholder="链接地址"
                value={newLinkForm.url}
                onChange={(e) => {
                  const value = e.target.value;
                  setNewLinkForm((prev) => ({ ...prev, url: value }));
                }}
              />
              <button type="submit" className="btn btn-sm btn-primary mr-2">
                添加
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setIsAddingLink(false);
                  setNewLinkForm(EMPTY_LINK_FORM);
                }}
              >
                取消
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );

  const renderSkillCard = () => {
    if (isLoadingSkill || !skillForm) return <div className="pl-empty">加载中...</div>;
    return (
      <div className="pl-card">
        {isSkillGenerating && <div className="alert alert-info py-2">正在由AI生成知识卡片…</div>}
        {!isSkillGenerating && !skillCard && (
          <div className="alert alert-info py-2">此主题暂无知识卡片（可能内容尚未生成，或生成失败）。</div>
        )}
        {skillCard && (
          <p className="pl-subtitle">
            {skillCard.sourceType === "admin" ? "管理员已审核" : "AI 自动生成，尚未审核"}
          </p>
        )}
        <div className="form-group">
          <label>标题</label>
          <input
            type="text"
            className="form-control"
            value={skillForm.title}
            disabled={!isAdmin}
            onChange={(e) => updateSkillForm("title", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>摘要</label>
          <textarea
            className="form-control"
            rows={4}
            value={skillForm.summary}
            disabled={!isAdmin}
            onChange={(e) => updateSkillForm("summary", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>要点（每行一条）</label>
          <textarea
            className="form-control"
            rows={4}
            value={skillForm.keyPointsText}
            disabled={!isAdmin}
            onChange={(e) => updateSkillForm("keyPointsText", e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>标签（顿号或逗号分隔）</label>
          <input
            type="text"
            className="form-control"
            value={skillForm.tagsText}
            disabled={!isAdmin}
            onChange={(e) => updateSkillForm("tagsText", e.target.value)}
          />
        </div>
        {isAdmin && (
          <button type="button" className="btn btn-primary" disabled={!skillDirty} onClick={saveSkill}>
            保存
          </button>
        )}
        <KnowledgeIndex topicId={selected.topicId} isAdmin={isAdmin} />
      </div>
    );
  };

  // Read-only in-page rendering of the auto-generated manual topic's document
  // -- deliberately not the 基本信息/材料内容/视频链接/知识卡片 tab set (see
  // isManualTopic's own comment above): a teacher opening 使用指南/教师手册
  // should land straight on readable content, not a file manager.
  const renderManualViewer = () => (
    <div className="pl-card">
      {isLoadingManualDoc && <div className="pl-empty">加载中...</div>}
      {!isLoadingManualDoc && manualLoadError && <div className="alert alert-info py-2">{manualLoadError}</div>}
      {!isLoadingManualDoc && manualHtml !== null && (
        <>
          {manualArtifact && (
            <div className="d-flex justify-content-between align-items-center mb-3">
              <span className="text-muted" style={{ fontSize: "0.85em" }}>
                {manualArtifact.attachmentName}
                {manualArtifact.updatedAt && ` · 更新于 ${new Date(manualArtifact.updatedAt).toLocaleString("zh-cn")}`}
              </span>
              <button
                type="button"
                className="btn btn-outline-primary btn-sm"
                onClick={async () => {
                  try {
                    const resp = await MaterialArtifactDataService.download(manualArtifact.id);
                    const url = window.URL.createObjectURL(
                      new Blob([resp.data], {
                        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      })
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.setAttribute("download", manualArtifact.attachmentName);
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    window.URL.revokeObjectURL(url);
                  } catch (e) {
                    setMessage("下载失败。");
                  }
                }}
              >
                下载 Word 文档
              </button>
            </div>
          )}
          <div className="pl-manual-doc" dangerouslySetInnerHTML={{ __html: manualHtml }} />
        </>
      )}
    </div>
  );

  const renderContent = () => {
    if (!selected.topicId || !selected.key) {
      return <div className="pl-empty">请选择左侧主题。</div>;
    }
    if (selected.key === "basic") return renderBasicInfo();
    if (selected.key === "links") return renderLinks();
    if (selected.key === "skill") return renderSkillCard();
    if (selected.key === "manual") return renderManualViewer();
    if (selected.key === "contents") {
      return (
        <LessonFileManager
          planId={selected.topicId}
          lessonIndex={null}
          canEdit={isAdmin}
          canDownload={canDownload}
          folderService={MaterialFolderDataService}
          artifactService={MaterialArtifactDataService}
          docCategoryLabel="Word文档"
          downloadUrlBase="/api/material-artifacts"
        />
      );
    }
    return null;
  };

  if (isLoading) {
    return (
      <div className="container pl-page">
        <div className="pl-empty">加载中...</div>
      </div>
    );
  }

  return (
    <div className="container pl-page">
      <div className="pl-hero">
        <h4 className="pl-title">学习资源库</h4>
      </div>

      {isAdmin && (
        <div className="pl-card mb-4">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <h6 className="mb-0">教师手册</h6>
          </div>
          <p className="text-muted mb-2">
            教师使用手册根据系统当前功能自动生成，涵盖课程设计的创建/编辑/保存/提交/上传/下载/删除、专家评审、AI 点评、
            评审历史、AI 讨论、欣欣助手、执行阶段支撑材料管理与模板迁移等内容。
          </p>
          <button
            type="button"
            className="btn btn-outline-primary btn-sm mr-2"
            onClick={downloadTeacherManual}
            disabled={!!manualBusy}
          >
            {manualBusy === "download" ? "生成中..." : "下载最新教师手册"}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={publishTeacherManual} disabled={!!manualBusy}>
            {manualBusy === "publish" ? "发布中..." : "生成并发布到「使用指南 / 教师手册」"}
          </button>
          <div className="text-muted mt-2" style={{ fontSize: "0.85em" }}>
            发布后将出现在下方的「使用指南 / 教师手册」主题下，教师可自行查看；再次发布会更新同一份文件。
            首次发布之后，系统每次更新上线时如手册内容有变化，会自动重新发布（欣欣助手据此回答系统使用问题）。
          </div>
        </div>
      )}

      <div className="pl-explorer">
        <button
          type="button"
          className="pl-explorer-hide-toggle"
          onClick={() => setNavCollapsed((prev) => !prev)}
          title={navCollapsed ? "显示导航" : "隐藏导航"}
        >
          <i className={`fas fa-${navCollapsed ? "angle-double-right" : "angle-double-left"}`}></i>
        </button>

        {!navCollapsed && (
          <div className="pl-explorer-nav">
            <form onSubmit={runSearch} className="mb-2">
              <div className="input-group input-group-sm">
                <input
                  type="text"
                  className="form-control"
                  placeholder="搜索材料库..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <div className="input-group-append">
                  <button type="submit" className="btn btn-outline-secondary" disabled={isSearching}>
                    <i className="fas fa-search"></i>
                  </button>
                </div>
              </div>
            </form>
            {searchResults !== null && (
              <div className="pl-explorer-empty mb-2">
                {searchResults.length === 0 ? (
                  "未找到相关材料。"
                ) : (
                  <ul className="list-unstyled mb-0">
                    {searchResults.map((r) => (
                      <li key={r.topicId}>
                        <button type="button" className="btn btn-sm btn-link p-0" onClick={() => jumpToSearchResult(r)}>
                          {r.category} · {r.theme}
                        </button>
                        <div className="text-truncate" style={{ maxWidth: "220px" }}>
                          {r.snippet}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {isAdmin && !isCreatingTopic && (
              <button type="button" className="btn btn-sm btn-outline-primary mb-2" onClick={() => setIsCreatingTopic(true)}>
                <i className="fas fa-plus mr-1"></i>新建主题
              </button>
            )}
            {isAdmin && isCreatingTopic && (
              <form onSubmit={submitCreateTopic} className="pl-fm-new-folder-form mb-2">
                <div className="mb-1">
                  <CreatableSelect
                    options={categoryOptions}
                    value={newTopicForm.category ? { value: newTopicForm.category, label: newTopicForm.category } : null}
                    isClearable
                    placeholder="分类（选择已有或输入新的，如：2026 或 示范资料）"
                    formatCreateLabel={(input) => `新建分类：${input}`}
                    onChange={(option) => setNewTopicForm((prev) => ({ ...prev, category: option ? option.value : "" }))}
                  />
                </div>
                {/* textarea, not a single-line input -- 主题名称 can run
                    long, and this keeps it fully visible/wrapped within the
                    narrow nav column instead of scrolling off sideways;
                    overflowY: auto caps growth and scrolls internally past
                    maxHeight. */}
                <textarea
                  className="form-control form-control-sm mb-1"
                  placeholder="主题名称"
                  autoFocus
                  rows={2}
                  style={{ resize: "vertical", overflowY: "auto", maxHeight: "120px" }}
                  value={newTopicForm.theme}
                  onChange={(e) => {
                    const value = e.target.value;
                    setNewTopicForm((prev) => ({ ...prev, theme: value }));
                  }}
                />
                <input
                  type="text"
                  className="form-control form-control-sm mb-1"
                  placeholder="主讲人"
                  value={newTopicForm.lecturer}
                  onChange={(e) => {
                    const value = e.target.value;
                    setNewTopicForm((prev) => ({ ...prev, lecturer: value }));
                  }}
                />
                <button type="submit" className="btn btn-sm btn-primary mr-2">
                  创建
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    setIsCreatingTopic(false);
                    setNewTopicForm(EMPTY_TOPIC_FORM);
                  }}
                >
                  取消
                </button>
              </form>
            )}

            {topicsByCategory.length === 0 && <div className="pl-explorer-empty">暂无材料。</div>}

            {topicsByCategory.map(([category, categoryTopics]) => (
              <div className="pl-explorer-group" key={category}>
                <div className="pl-explorer-row">
                  {renamingCategory === category ? (
                    <form
                      className="pl-explorer-rename-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        submitRenameCategory(category);
                      }}
                    >
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        autoFocus
                        disabled={busyCategory === category}
                        value={renameCategoryValue}
                        onChange={(e) => setRenameCategoryValue(e.target.value)}
                        onBlur={() => submitRenameCategory(category)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") cancelRenameCategory();
                        }}
                      />
                      {busyCategory === category && (
                        <span className="spinner-border spinner-border-sm pl-explorer-row-spinner" role="status"></span>
                      )}
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="pl-explorer-folder pl-explorer-row-main"
                      onClick={() => toggleCategory(category)}
                    >
                      <i className={`fas fa-chevron-${expandedCategories[category] ? "down" : "right"} pl-explorer-chevron`}></i>
                      <i className="fas fa-folder-open pl-folder-icon mr-1"></i> {category}
                    </button>
                  )}
                  {renamingCategory !== category && busyCategory === category && (
                    <span className="pl-explorer-row-actions pl-explorer-row-actions-busy">
                      <span className="spinner-border spinner-border-sm pl-explorer-row-spinner" role="status"></span>
                    </span>
                  )}
                  {isAdmin && renamingCategory !== category && busyCategory !== category && (
                    <span className="pl-explorer-row-actions">
                      {category !== MANUAL_CATEGORY && (
                        <button
                          type="button"
                          className="pl-explorer-row-action"
                          title="重命名"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRenameCategory(category);
                          }}
                        >
                          <i className="fas fa-pencil-alt"></i>
                        </button>
                      )}
                      <button
                        type="button"
                        className="pl-explorer-row-action"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteCategoryByValue(category, categoryTopics.length);
                        }}
                      >
                        <i className="fas fa-trash-alt"></i>
                      </button>
                    </span>
                  )}
                </div>
                {expandedCategories[category] && (
                  <div className="pl-explorer-children">
                    {categoryTopics.map((topic) => (
                      <div className="pl-explorer-subgroup" key={topic.id}>
                      <div className="pl-explorer-row">
                        {renamingTopicId === topic.id ? (
                          <form
                            className="pl-explorer-rename-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              submitRenameTopic(topic.id);
                            }}
                          >
                            <input
                              type="text"
                              className="form-control form-control-sm"
                              autoFocus
                              disabled={busyTopicId === topic.id}
                              value={renameTopicValue}
                              onChange={(e) => setRenameTopicValue(e.target.value)}
                              onBlur={() => submitRenameTopic(topic.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") cancelRenameTopic();
                              }}
                            />
                            {busyTopicId === topic.id && (
                              <span className="spinner-border spinner-border-sm pl-explorer-row-spinner" role="status"></span>
                            )}
                          </form>
                        ) : isManualTopic(topic) ? (
                          // The auto-generated manual topic has exactly one
                          // thing to show (see renderManualViewer) -- clicking
                          // the row itself opens it directly instead of
                          // expanding into a single redundant child leaf
                          // underneath. Any other 使用指南 topic (e.g. a
                          // hand-written 使用说明) falls through to the normal
                          // expand/leaf branch below.
                          <button
                            type="button"
                            className={`pl-explorer-folder pl-explorer-subfolder pl-explorer-row-main ${
                              selected.topicId === topic.id && selected.key === "manual" ? "is-active" : ""
                            }`}
                            onClick={() => select(topic.id, "manual")}
                          >
                            <i className="fas fa-book pl-explorer-chevron"></i>
                            {topic.theme}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="pl-explorer-folder pl-explorer-subfolder pl-explorer-row-main"
                            onClick={() => toggleTopic(topic.id)}
                          >
                            <i className={`fas fa-chevron-${expandedTopics[topic.id] ? "down" : "right"} pl-explorer-chevron`}></i>
                            {topic.theme}
                          </button>
                        )}
                        {renamingTopicId !== topic.id && busyTopicId === topic.id && (
                          <span className="pl-explorer-row-actions pl-explorer-row-actions-busy">
                            <span className="spinner-border spinner-border-sm pl-explorer-row-spinner" role="status"></span>
                          </span>
                        )}
                        {isAdmin && renamingTopicId !== topic.id && busyTopicId !== topic.id && (
                          <span className="pl-explorer-row-actions">
                            {!isManualTopic(topic) && (
                              <button
                                type="button"
                                className="pl-explorer-row-action"
                                title="重命名"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startRenameTopic(topic);
                                }}
                              >
                                <i className="fas fa-pencil-alt"></i>
                              </button>
                            )}
                            <button
                              type="button"
                              className="pl-explorer-row-action"
                              title="删除"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteTopicById(topic.id);
                              }}
                            >
                              <i className="fas fa-trash-alt"></i>
                            </button>
                          </span>
                        )}
                      </div>
                        {expandedTopics[topic.id] && !isManualTopic(topic) && (
                          <div className="pl-explorer-children pl-explorer-children-nested">
                            <button
                              type="button"
                              className={`pl-explorer-leaf ${
                                selected.topicId === topic.id && selected.key === "basic" ? "is-active" : ""
                              }`}
                              onClick={() => select(topic.id, "basic")}
                            >
                              基本信息
                            </button>
                            <button
                              type="button"
                              className={`pl-explorer-leaf ${
                                selected.topicId === topic.id && selected.key === "contents" ? "is-active" : ""
                              }`}
                              onClick={() => select(topic.id, "contents")}
                            >
                              材料内容
                            </button>
                            <button
                              type="button"
                              className={`pl-explorer-leaf ${
                                selected.topicId === topic.id && selected.key === "links" ? "is-active" : ""
                              }`}
                              onClick={() => select(topic.id, "links")}
                            >
                              视频链接
                            </button>
                            <button
                              type="button"
                              className={`pl-explorer-leaf ${
                                selected.topicId === topic.id && selected.key === "skill" ? "is-active" : ""
                              }`}
                              onClick={() => select(topic.id, "skill")}
                            >
                              知识卡片
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="pl-explorer-content">
          {message && <div className="alert alert-info py-2">{message}</div>}
          {renderContent()}
        </div>
      </div>
    </div>
  );
};

export default MaterialsLibrary;
