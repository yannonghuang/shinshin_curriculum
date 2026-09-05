import React, { useCallback, useEffect, useMemo, useState } from "react";

import MaterialTopicDataService from "../services/material-topic.service";
import MaterialLinkDataService from "../services/material-link.service";
import MaterialFolderDataService from "../services/material-folder.service";
import MaterialArtifactDataService from "../services/material-artifact.service";
import AuthService from "../services/auth.service";
import LessonFileManager from "./lesson-file-manager.component";
import "../curriculum.css";

// 共享学习材料库 -- a Year -> Theme(主题/Event) tree, laid out like
// plan-detail.component.js's own explorer (left nav tree, right content
// pane). Purely admin-curated (unlike Plan's teacher ownership): admins
// create/edit/delete every Theme and its contents, teachers/experts only
// browse/download -- no draft/submitted workflow, no owner concept at all.
// "material contents" reuses lesson-file-manager.component.js's mini cloud
// file system, scoped by materialTopicId instead of (planId, lessonIndex)
// via the material-folder.service.js/material-artifact.service.js pair (see
// that component's folderService/artifactService props).
const EMPTY_TOPIC_FORM = { year: new Date().getFullYear(), theme: "", lecturer: "", comment: "" };
const EMPTY_LINK_FORM = { description: "", url: "" };

const MaterialsLibrary = () => {
  const isAdmin = AuthService.isAdmin();
  const isTeacher = AuthService.isTeacher();
  const isExpert = AuthService.isExpert();
  const canDownload = isAdmin || isTeacher || isExpert;

  const [topics, setTopics] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [expandedYears, setExpandedYears] = useState({});
  const [expandedTopics, setExpandedTopics] = useState({});
  const [selected, setSelected] = useState({ topicId: null, key: null });

  const [isCreatingTopic, setIsCreatingTopic] = useState(false);
  const [newTopicForm, setNewTopicForm] = useState(EMPTY_TOPIC_FORM);

  const [metaForm, setMetaForm] = useState(null);
  const [metaDirty, setMetaDirty] = useState(false);

  const [links, setLinks] = useState([]);
  const [isLoadingLinks, setIsLoadingLinks] = useState(false);
  const [isAddingLink, setIsAddingLink] = useState(false);
  const [newLinkForm, setNewLinkForm] = useState(EMPTY_LINK_FORM);
  const [editingLinkId, setEditingLinkId] = useState(null);
  const [editLinkForm, setEditLinkForm] = useState(EMPTY_LINK_FORM);

  const retrieveTopics = useCallback(async () => {
    setIsLoading(true);
    try {
      const resp = await MaterialTopicDataService.getAll();
      setTopics(Array.isArray(resp.data) ? resp.data : []);
    } catch (e) {
      console.log(e);
      setMessage("加载共享学习材料库失败。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    retrieveTopics();
  }, [retrieveTopics]);

  const selectedTopic = useMemo(
    () => topics.find((t) => t.id === selected.topicId) || null,
    [topics, selected.topicId]
  );

  useEffect(() => {
    if (selected.key === "basic" && selectedTopic) {
      setMetaForm({
        year: selectedTopic.year,
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
      setMessage("加载材料链接失败。");
    } finally {
      setIsLoadingLinks(false);
    }
  }, []);

  useEffect(() => {
    if (selected.key === "links" && selected.topicId) {
      retrieveLinks(selected.topicId);
    }
  }, [selected.key, selected.topicId, retrieveLinks]);

  const topicsByYear = useMemo(() => {
    const byYear = new Map();
    for (const t of topics) {
      if (!byYear.has(t.year)) byYear.set(t.year, []);
      byYear.get(t.year).push(t);
    }
    return Array.from(byYear.entries()).sort((a, b) => b[0] - a[0]);
  }, [topics]);

  const toggleYear = (year) => setExpandedYears((prev) => ({ ...prev, [year]: !prev[year] }));
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

  const deleteTopic = async () => {
    if (!window.confirm("此操作将永久删除该主题及其所有材料内容和链接，且无法撤销。确定继续吗？")) return;
    try {
      await MaterialTopicDataService.delete(selectedTopic.id, true);
      setSelected({ topicId: null, key: null });
      setMessage("主题已删除。");
      await retrieveTopics();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    }
  };

  const submitCreateTopic = async (e) => {
    e.preventDefault();
    if (!newTopicForm.theme.trim() || !newTopicForm.year) {
      setMessage("请填写年份和主题名称。");
      return;
    }
    try {
      const resp = await MaterialTopicDataService.create(newTopicForm);
      setIsCreatingTopic(false);
      setNewTopicForm(EMPTY_TOPIC_FORM);
      await retrieveTopics();
      setExpandedYears((prev) => ({ ...prev, [resp.data.year]: true }));
      setExpandedTopics((prev) => ({ ...prev, [resp.data.id]: true }));
      select(resp.data.id, "basic");
    } catch (err) {
      setMessage(err?.response?.data?.message || "创建主题失败。");
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

  const renderBasicInfo = () => {
    if (!metaForm) return null;
    return (
      <div className="pl-card">
        <div className="form-group">
          <label>年份</label>
          <input
            type="number"
            className="form-control"
            value={metaForm.year}
            disabled={!isAdmin}
            onChange={(e) => updateMetaForm("year", Number(e.target.value))}
          />
        </div>
        <div className="form-group">
          <label>主题</label>
          <input
            type="text"
            className="form-control"
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
            <button type="button" className="btn btn-primary" disabled={!metaDirty} onClick={saveMeta}>
              保存
            </button>
            <button type="button" className="btn btn-outline-danger" onClick={deleteTopic}>
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
          {links.length === 0 && <div className="pl-empty">暂无材料链接。</div>}
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

  const renderContent = () => {
    if (!selected.topicId || !selected.key) {
      return <div className="pl-empty">请选择左侧主题。</div>;
    }
    if (selected.key === "basic") return renderBasicInfo();
    if (selected.key === "links") return renderLinks();
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
        <h4 className="pl-title">共享学习材料库</h4>
      </div>

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
            {isAdmin && !isCreatingTopic && (
              <button type="button" className="btn btn-sm btn-outline-primary mb-2" onClick={() => setIsCreatingTopic(true)}>
                <i className="fas fa-plus mr-1"></i>新建主题
              </button>
            )}
            {isAdmin && isCreatingTopic && (
              <form onSubmit={submitCreateTopic} className="pl-fm-new-folder-form mb-2">
                <input
                  type="number"
                  className="form-control form-control-sm mb-1"
                  placeholder="年份"
                  value={newTopicForm.year}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    setNewTopicForm((prev) => ({ ...prev, year: value }));
                  }}
                />
                <input
                  type="text"
                  className="form-control form-control-sm mb-1"
                  placeholder="主题名称"
                  autoFocus
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

            {topicsByYear.length === 0 && <div className="pl-explorer-empty">暂无材料。</div>}

            {topicsByYear.map(([year, yearTopics]) => (
              <div className="pl-explorer-group" key={year}>
                <button type="button" className="pl-explorer-folder" onClick={() => toggleYear(year)}>
                  <i className={`fas fa-chevron-${expandedYears[year] ? "down" : "right"} pl-explorer-chevron`}></i>
                  <i className="fas fa-folder-open mr-1"></i> {year}
                </button>
                {expandedYears[year] && (
                  <div className="pl-explorer-children">
                    {yearTopics.map((topic) => (
                      <div className="pl-explorer-subgroup" key={topic.id}>
                        <button
                          type="button"
                          className="pl-explorer-folder pl-explorer-subfolder"
                          onClick={() => toggleTopic(topic.id)}
                        >
                          <i className={`fas fa-chevron-${expandedTopics[topic.id] ? "down" : "right"} pl-explorer-chevron`}></i>
                          {topic.theme}
                        </button>
                        {expandedTopics[topic.id] && (
                          <div className="pl-explorer-children pl-explorer-children-nested">
                            <button
                              type="button"
                              className={`pl-explorer-leaf ${selected.topicId === topic.id && selected.key === "basic" ? "is-active" : ""}`}
                              onClick={() => select(topic.id, "basic")}
                            >
                              基本信息
                            </button>
                            <button
                              type="button"
                              className={`pl-explorer-leaf ${selected.topicId === topic.id && selected.key === "contents" ? "is-active" : ""}`}
                              onClick={() => select(topic.id, "contents")}
                            >
                              材料内容
                            </button>
                            <button
                              type="button"
                              className={`pl-explorer-leaf ${selected.topicId === topic.id && selected.key === "links" ? "is-active" : ""}`}
                              onClick={() => select(topic.id, "links")}
                            >
                              材料链接
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
