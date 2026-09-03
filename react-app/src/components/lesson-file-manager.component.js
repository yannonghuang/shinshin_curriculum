import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mammoth from "mammoth/mammoth.browser";

import ArtifactDataService from "../services/artifact.service";
import FolderDataService from "../services/folder.service";

// A "mini cloud file system" for one 课时's 实施记录 file space (Google-Drive-
// style: whole panel is the drop target, real user-created folders, list/icon
// views, multi-select group actions) -- see folder.model.js/folder.controller.js
// for the backend side. Deliberately NOT reused for the plan-level 课程设计文件
// panel (ArtifactPanel, in plan-detail.component.js): that one only ever holds
// the single doc generated from the plan's own online content, no folders, no
// upload at all (allowUpload=false) -- a real file browser there would be
// solving a problem that panel doesn't have.
//
// Folders replace category (实施记录文件/课件PPT/图片/视频) as the browsing/
// organizing structure -- category is kept only as per-file metadata (still
// auto-inferred from extension, still used for the icon and stored on the
// artifact row) since other code (AI review prompts, bulk zip import/export)
// still reads it, but nothing here groups or sections files by it anymore.
//
// Drag-and-drop of whole folders (not just files) works by reading each
// dropped DataTransferItem as a FileSystemEntry (walkEntry) -- a
// FileSystemDirectoryEntry becomes a real folder (created via the API,
// preserving nesting) before its files upload into it; a browser without
// webkitGetAsEntry support just falls back to flat file uploads into the
// current folder.

const inferCategoryFromFilename = (filename) => {
  const ext = (filename || "").toLowerCase().split(".").pop();
  if (["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"].includes(ext)) return "视频";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "heic"].includes(ext)) return "图片";
  if (["ppt", "pptx"].includes(ext)) return "课件PPT";
  return "实施记录文件";
};

const ARTIFACT_ICONS = { 视频: "fas fa-file-video", 图片: "fas fa-file-image", 课件PPT: "fas fa-file-powerpoint" };
const iconClassForArtifact = (artifact) => {
  const type = (artifact.type || "").toLowerCase();
  if (type === "pdf") return "fas fa-file-pdf";
  if (["doc", "docx"].includes(type)) return "fas fa-file-word";
  if (["xls", "xlsx"].includes(type)) return "fas fa-file-excel";
  return ARTIFACT_ICONS[artifact.category] || "fas fa-file";
};

const formatBytes = (bytes) => {
  if (bytes === null || bytes === undefined) return "-";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

// Walks one dropped FileSystemEntry, creating a real folder for every
// FileSystemDirectoryEntry (nested ones recursively, preserving structure)
// and collecting { file, folderId } pairs for every FileSystemFileEntry --
// out is populated in place so a whole multi-item drop shares one array.
const readEntryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
const readAllDirectoryEntries = async (reader) => {
  let all = [];
  let batch;
  do {
    // Directory readers are stateful/sequential by spec; readEntries must be
    // awaited one call at a time (it doesn't return everything in one call
    // for large directories).
    // eslint-disable-next-line no-await-in-loop
    batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    all = all.concat(batch);
  } while (batch.length > 0);
  return all;
};
const walkEntry = async (entry, parentFolderId, planId, lessonIndex, out) => {
  if (!entry) return;
  if (entry.isFile) {
    const file = await readEntryFile(entry);
    out.push({ file, folderId: parentFolderId });
    return;
  }
  if (entry.isDirectory) {
    const created = await FolderDataService.create(planId, { lessonIndex, parentFolderId, name: entry.name });
    const newFolderId = created.data.id;
    const children = await readAllDirectoryEntries(entry.createReader());
    // Each child folder's own creation depends on its parent already
    // existing, so this can't run in parallel across the tree.
    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop
      await walkEntry(child, newFolderId, planId, lessonIndex, out);
    }
  }
};

const LessonFileManager = ({ planId, lessonIndex, canEdit }) => {
  const [folders, setFolders] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [currentFolderId, setCurrentFolderId] = useState(null);
  const [viewMode, setViewMode] = useState("list");
  const [selectedFolderIds, setSelectedFolderIds] = useState(new Set());
  const [selectedArtifactIds, setSelectedArtifactIds] = useState(new Set());
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [message, setMessage] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveDialogFolderId, setMoveDialogFolderId] = useState(null); // picker's own current folder
  const previewRef = useRef(null);
  const [previewArtifact, setPreviewArtifact] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMime, setPreviewMime] = useState("");
  const [previewDocxHtml, setPreviewDocxHtml] = useState("");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const refreshFolders = useCallback(async () => {
    try {
      const resp = await FolderDataService.getByPlan(planId, lessonIndex);
      setFolders(Array.isArray(resp.data) ? resp.data : []);
    } catch (e) {
      console.log(e);
      setMessage("加载文件夹列表失败。");
    }
  }, [planId, lessonIndex]);

  const refreshArtifacts = useCallback(async () => {
    try {
      const resp = await ArtifactDataService.getByPlan(planId, lessonIndex);
      const list = Array.isArray(resp.data) ? resp.data : resp.data.rows || resp.data.artifacts || [];
      setArtifacts(list);
    } catch (e) {
      console.log(e);
      setMessage("加载附件列表失败。");
    }
  }, [planId, lessonIndex]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshFolders(), refreshArtifacts()]);
  }, [refreshFolders, refreshArtifacts]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    return () => {
      if (previewUrl) window.URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // If the folder currently open (or being used as the move-dialog target)
  // was deleted out from under us (e.g. by another tab), fall back to root
  // rather than showing a folder that no longer exists.
  useEffect(() => {
    if (currentFolderId && folders.length > 0 && !folders.some((f) => f.id === currentFolderId)) {
      setCurrentFolderId(null);
    }
  }, [folders, currentFolderId]);

  const clearSelection = () => {
    setSelectedFolderIds(new Set());
    setSelectedArtifactIds(new Set());
  };

  const enterFolder = (id) => {
    setCurrentFolderId(id);
    clearSelection();
  };

  const breadcrumb = useMemo(() => {
    const chain = [];
    let cursor = currentFolderId;
    const byId = new Map(folders.map((f) => [f.id, f]));
    while (cursor) {
      const f = byId.get(cursor);
      if (!f) break;
      chain.unshift(f);
      cursor = f.parentFolderId;
    }
    return chain;
  }, [folders, currentFolderId]);

  const childFolders = useMemo(
    () => folders.filter((f) => (f.parentFolderId || null) === (currentFolderId || null)),
    [folders, currentFolderId]
  );
  const childArtifacts = useMemo(
    () => artifacts.filter((a) => (a.folderId || null) === (currentFolderId || null)),
    [artifacts, currentFolderId]
  );

  const toggleFolderSelection = (id) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleArtifactSelection = (id) => {
    setSelectedArtifactIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectionCount = selectedFolderIds.size + selectedArtifactIds.size;

  const uploadResolvedFiles = async (toUpload) => {
    if (toUpload.length === 0) return;
    setIsUploading(true);
    setUploadProgress(0);
    try {
      for (let i = 0; i < toUpload.length; i += 1) {
        const { file, folderId } = toUpload[i];
        const formData = new FormData();
        formData.append("description", "");
        formData.append("category", inferCategoryFromFilename(file.name));
        formData.append("lessonIndex", lessonIndex);
        if (folderId) formData.append("folderId", folderId);
        formData.append("file", file);
        // Sequential upload mirrors the existing ArtifactPanel behavior
        // (progress % per file); parallel uploads would need their own
        // progress-aggregation logic for no real benefit at the file counts
        // this panel sees.
        // eslint-disable-next-line no-await-in-loop
        await ArtifactDataService.create(planId, formData);
        setUploadProgress(Math.round(((i + 1) * 100) / toUpload.length));
      }
      setMessage(`已上传 ${toUpload.length} 个文件。`);
    } catch (err) {
      setMessage(err?.response?.data?.message || "上传失败。");
    } finally {
      setIsUploading(false);
      setTimeout(() => setUploadProgress(null), 600);
      await refreshAll();
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!canEdit || isUploading) return;
    setMessage("");

    const items = e.dataTransfer && e.dataTransfer.items;
    // webkitGetAsEntry() existing doesn't guarantee it returns something --
    // e.g. a File constructed in JS rather than dragged from the OS resolves
    // to null even in a browser that supports the method -- so the real
    // fallback condition is "did we get zero usable entries", not just
    // "is the method missing".
    const entries = items
      ? Array.from(items)
          .map((it) => (typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null))
          .filter(Boolean)
      : [];

    if (entries.length > 0) {
      try {
        const toUpload = [];
        // Each top-level dropped item can itself create folders the next one
        // might nest into if they share a name (unlikely, but sequential
        // keeps behavior predictable and avoids duplicate-folder races
        // either way).
        for (const entry of entries) {
          // eslint-disable-next-line no-await-in-loop
          await walkEntry(entry, currentFolderId, planId, lessonIndex, toUpload);
        }
        await uploadResolvedFiles(toUpload);
      } catch (err) {
        console.log(err);
        setMessage("上传失败。");
        await refreshAll();
      }
      return;
    }

    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    await uploadResolvedFiles(files.map((file) => ({ file, folderId: currentFolderId })));
  };

  const startCreateFolder = () => {
    setIsCreatingFolder(true);
    setNewFolderName("");
  };
  const submitCreateFolder = async (e) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) {
      setIsCreatingFolder(false);
      return;
    }
    try {
      await FolderDataService.create(planId, { lessonIndex, parentFolderId: currentFolderId, name });
      setIsCreatingFolder(false);
      setNewFolderName("");
      refreshFolders();
    } catch (err) {
      setMessage(err?.response?.data?.message || "新建文件夹失败。");
    }
  };

  const previewArtifactContent = async (artifact) => {
    try {
      setIsPreviewLoading(true);
      if (previewUrl) window.URL.revokeObjectURL(previewUrl);
      setPreviewDocxHtml("");
      const resp = await ArtifactDataService.download(artifact.id);
      const mime = artifact.attachmentMime || "application/octet-stream";
      const ext = (artifact.attachmentName || "").toLowerCase().split(".").pop();
      if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const result = await mammoth.convertToHtml({ arrayBuffer: resp.data });
        setPreviewArtifact(artifact);
        setPreviewMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        setPreviewDocxHtml(result.value || "<p>文档内容为空。</p>");
        setPreviewUrl("");
      } else {
        const url = window.URL.createObjectURL(new Blob([resp.data], { type: mime }));
        setPreviewArtifact(artifact);
        setPreviewMime(mime);
        setPreviewUrl(url);
      }
      setTimeout(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 0);
    } catch (e) {
      console.log(e);
      setMessage("预览失败。若为 .doc 文件，请使用下载。");
    } finally {
      setIsPreviewLoading(false);
    }
  };
  const closePreview = () => {
    if (previewUrl) window.URL.revokeObjectURL(previewUrl);
    setPreviewArtifact(null);
    setPreviewUrl("");
    setPreviewMime("");
    setPreviewDocxHtml("");
  };

  const downloadArtifact = async (artifact) => {
    try {
      const resp = await ArtifactDataService.download(artifact.id);
      const url = window.URL.createObjectURL(new Blob([resp.data], { type: artifact.attachmentMime || "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", artifact.attachmentName || `artifact-${artifact.id}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.log(e);
      setMessage("下载失败。");
    }
  };

  const downloadSelected = async () => {
    const items = childArtifacts.filter((a) => selectedArtifactIds.has(a.id));
    if (selectedFolderIds.size > 0) {
      setMessage(`文件夹暂不支持下载，已跳过 ${selectedFolderIds.size} 个文件夹，仅下载已选择的文件。`);
    }
    // Triggering several simultaneous browser downloads at once is what gets
    // them blocked as a popup flood; one at a time is deliberate.
    for (const artifact of items) {
      // eslint-disable-next-line no-await-in-loop
      await downloadArtifact(artifact);
    }
  };

  const deleteSelected = async () => {
    if (selectionCount === 0) return;
    const ok = window.confirm(
      `此操作将永久删除已选择的 ${selectionCount} 项${selectedFolderIds.size > 0 ? "（含文件夹内的所有内容）" : ""}，且无法撤销。确定继续吗？`
    );
    if (!ok) return;
    try {
      // Matches the existing one-request-at-a-time delete pattern used
      // elsewhere in this app.
      for (const id of selectedArtifactIds) {
        // eslint-disable-next-line no-await-in-loop
        await ArtifactDataService.delete(id, true);
      }
      for (const id of selectedFolderIds) {
        // eslint-disable-next-line no-await-in-loop
        await FolderDataService.delete(id, true);
      }
      setMessage("删除成功。");
      clearSelection();
      refreshAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    }
  };

  const openMoveDialog = () => {
    setMoveDialogFolderId(null);
    setMoveDialogOpen(true);
  };
  const confirmMove = async () => {
    const target = moveDialogFolderId;
    try {
      for (const id of selectedArtifactIds) {
        const formData = new FormData();
        formData.append("folderId", target === null ? "root" : target);
        // eslint-disable-next-line no-await-in-loop
        await ArtifactDataService.update(id, formData);
      }
      for (const id of selectedFolderIds) {
        // eslint-disable-next-line no-await-in-loop
        await FolderDataService.update(id, { parentFolderId: target });
      }
      setMoveDialogOpen(false);
      clearSelection();
      refreshAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "移动失败。");
    }
  };

  const onlyOneFileSelected = selectionCount === 1 && selectedArtifactIds.size === 1;

  const renderItemCheckbox = (checked, onChange) => (
    <input type="checkbox" className="pl-fm-checkbox" checked={checked} onChange={onChange} onClick={(e) => e.stopPropagation()} />
  );

  const renderFolderRow = (folder, isIcon) => {
    const checked = selectedFolderIds.has(folder.id);

    if (isIcon) {
      return (
        <div key={`folder-${folder.id}`} className={`pl-fm-icon-item ${checked ? "is-selected" : ""}`} onClick={() => enterFolder(folder.id)}>
          {canEdit && renderItemCheckbox(checked, () => toggleFolderSelection(folder.id))}
          <i className="fas fa-folder pl-fm-icon-glyph pl-fm-folder-glyph"></i>
          <div className="pl-fm-icon-name">{folder.name}</div>
        </div>
      );
    }
    return (
      <tr key={`folder-${folder.id}`} className={checked ? "is-selected" : ""}>
        <td>{canEdit && renderItemCheckbox(checked, () => toggleFolderSelection(folder.id))}</td>
        <td className="pl-fm-name-cell" onClick={() => enterFolder(folder.id)}>
          <i className="fas fa-folder pl-fm-folder-glyph mr-2"></i>
          {folder.name}
        </td>
        <td>文件夹</td>
        <td>-</td>
        <td>{folder.updatedAt ? new Date(folder.updatedAt).toLocaleString("zh-cn") : "-"}</td>
      </tr>
    );
  };

  const renderArtifactRow = (artifact, isIcon) => {
    const checked = selectedArtifactIds.has(artifact.id);
    if (isIcon) {
      return (
        <div
          key={`file-${artifact.id}`}
          className={`pl-fm-icon-item ${checked ? "is-selected" : ""}`}
          onClick={() => previewArtifactContent(artifact)}
        >
          {canEdit && renderItemCheckbox(checked, () => toggleArtifactSelection(artifact.id))}
          <i className={`${iconClassForArtifact(artifact)} pl-fm-icon-glyph`}></i>
          <div className="pl-fm-icon-name" title={artifact.attachmentName}>
            {artifact.attachmentName}
          </div>
        </div>
      );
    }
    return (
      <tr key={`file-${artifact.id}`} className={checked ? "is-selected" : ""}>
        <td>{canEdit && renderItemCheckbox(checked, () => toggleArtifactSelection(artifact.id))}</td>
        <td className="pl-fm-name-cell" onClick={() => previewArtifactContent(artifact)} title={artifact.attachmentName}>
          <i className={`${iconClassForArtifact(artifact)} mr-2`}></i>
          {artifact.attachmentName}
        </td>
        <td>{artifact.type}</td>
        <td>{formatBytes(artifact.attachmentSize)}</td>
        <td>{artifact.createdAt ? new Date(artifact.createdAt).toLocaleString("zh-cn") : "-"}</td>
      </tr>
    );
  };

  // Folder picker used by the "移动到..." dialog -- its own independent
  // navigation state (moveDialogFolderId), separate from the main view's
  // currentFolderId, so browsing to pick a destination doesn't disturb where
  // the user actually is.
  const moveDialogChildFolders = folders.filter((f) => (f.parentFolderId || null) === (moveDialogFolderId || null) && !selectedFolderIds.has(f.id));
  const moveDialogBreadcrumb = (() => {
    const chain = [];
    let cursor = moveDialogFolderId;
    const byId = new Map(folders.map((f) => [f.id, f]));
    while (cursor) {
      const f = byId.get(cursor);
      if (!f) break;
      chain.unshift(f);
      cursor = f.parentFolderId;
    }
    return chain;
  })();

  return (
    <div>
      <div
        className={`pl-fm ${isDragOver ? "is-dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (canEdit && !isUploading) setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="pl-fm-toolbar">
          <div className="pl-fm-breadcrumb">
            <button type="button" className="btn btn-link p-0" onClick={() => enterFolder(null)}>
              根目录
            </button>
            {breadcrumb.map((f) => (
              <React.Fragment key={f.id}>
                <span className="mx-1">/</span>
                <button type="button" className="btn btn-link p-0" onClick={() => enterFolder(f.id)}>
                  {f.name}
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className="pl-fm-toolbar-actions">
            {canEdit && !isCreatingFolder && (
              <button type="button" className="btn btn-sm btn-outline-secondary mr-2" onClick={startCreateFolder}>
                <i className="fas fa-folder-plus mr-1"></i>新建文件夹
              </button>
            )}
            <div className="btn-group btn-group-sm" role="group">
              <button
                type="button"
                className={`btn btn-outline-secondary ${viewMode === "list" ? "active" : ""}`}
                onClick={() => setViewMode("list")}
                title="列表视图"
              >
                <i className="fas fa-list"></i>
              </button>
              <button
                type="button"
                className={`btn btn-outline-secondary ${viewMode === "icon" ? "active" : ""}`}
                onClick={() => setViewMode("icon")}
                title="图标视图"
              >
                <i className="fas fa-th-large"></i>
              </button>
            </div>
          </div>
        </div>

        {isCreatingFolder && (
          <form onSubmit={submitCreateFolder} className="pl-fm-new-folder-form">
            <i className="fas fa-folder pl-fm-folder-glyph mr-2"></i>
            <input
              className="form-control form-control-sm d-inline-block"
              style={{ width: "240px" }}
              autoFocus
              placeholder="文件夹名称"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={submitCreateFolder}
            />
          </form>
        )}

        {selectionCount > 0 && (
          <div className="pl-fm-selection-bar">
            <span>已选择 {selectionCount} 项</span>
            {onlyOneFileSelected && (
              <button
                type="button"
                className="btn btn-sm btn-link"
                onClick={() => previewArtifactContent(childArtifacts.find((a) => selectedArtifactIds.has(a.id)))}
              >
                预览
              </button>
            )}
            {selectedArtifactIds.size > 0 && (
              <button type="button" className="btn btn-sm btn-link" onClick={downloadSelected}>
                下载
              </button>
            )}
            {canEdit && (
              <button type="button" className="btn btn-sm btn-link" onClick={openMoveDialog}>
                移动到...
              </button>
            )}
            {canEdit && (
              <button type="button" className="btn btn-sm btn-link text-danger" onClick={deleteSelected}>
                删除
              </button>
            )}
            <button type="button" className="btn btn-sm btn-link text-muted" onClick={clearSelection}>
              取消选择
            </button>
          </div>
        )}

        {message && <div className="alert alert-info py-2">{message}</div>}
        {isUploading && (
          <div className="alert alert-info py-2">上传中...{uploadProgress !== null ? `${uploadProgress}%` : ""}</div>
        )}

        {childFolders.length === 0 && childArtifacts.length === 0 ? (
          <div className="pl-fm-empty">
            {canEdit ? "此文件夹为空 -- 将文件或文件夹拖拽到此处上传" : "此文件夹为空"}
          </div>
        ) : viewMode === "list" ? (
          <table className="table table-sm table-hover pl-fm-table">
            <thead>
              <tr>
                <th style={{ width: "32px" }}></th>
                <th>名称</th>
                <th style={{ width: "100px" }}>类型</th>
                <th style={{ width: "100px" }}>大小</th>
                <th style={{ width: "180px" }}>修改时间</th>
              </tr>
            </thead>
            <tbody>
              {childFolders.map((f) => renderFolderRow(f, false))}
              {childArtifacts.map((a) => renderArtifactRow(a, false))}
            </tbody>
          </table>
        ) : (
          <div className="pl-fm-icon-grid">
            {childFolders.map((f) => renderFolderRow(f, true))}
            {childArtifacts.map((a) => renderArtifactRow(a, true))}
          </div>
        )}
      </div>

      {previewArtifact && (
        <div ref={previewRef} className="pl-card mt-3">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <h6 className="mb-0">附件预览：{previewArtifact.attachmentName}</h6>
            <button className="btn btn-sm btn-outline-secondary" onClick={closePreview}>
              关闭预览
            </button>
          </div>
          {isPreviewLoading ? (
            <div>预览加载中...</div>
          ) : (
            <>
              {previewMime.startsWith("image/") && <img src={previewUrl} alt="artifact-preview" style={{ maxWidth: "100%" }} />}
              {previewMime.includes("pdf") && <iframe title="artifact-pdf-preview" src={previewUrl} style={{ width: "100%", height: "600px" }} />}
              {previewMime.startsWith("video/") && <video controls src={previewUrl} style={{ width: "100%" }} />}
              {previewMime.startsWith("audio/") && <audio controls src={previewUrl} style={{ width: "100%" }} />}
              {previewMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && (
                <div className="pl-docx-preview border rounded p-3 bg-white">
                  <div dangerouslySetInnerHTML={{ __html: previewDocxHtml }} />
                </div>
              )}
              {!previewMime.startsWith("image/") &&
                !previewMime.includes("pdf") &&
                !previewMime.startsWith("video/") &&
                !previewMime.startsWith("audio/") &&
                previewMime !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && <div>当前文件类型不支持内嵌预览，请使用下载。</div>}
            </>
          )}
        </div>
      )}

      {moveDialogOpen && (
        <div className="pl-fm-modal-backdrop" onClick={() => setMoveDialogOpen(false)}>
          <div className="pl-fm-modal" onClick={(e) => e.stopPropagation()}>
            <h6>移动到...</h6>
            <div className="pl-fm-breadcrumb mb-2">
              <button type="button" className="btn btn-link p-0" onClick={() => setMoveDialogFolderId(null)}>
                根目录
              </button>
              {moveDialogBreadcrumb.map((f) => (
                <React.Fragment key={f.id}>
                  <span className="mx-1">/</span>
                  <button type="button" className="btn btn-link p-0" onClick={() => setMoveDialogFolderId(f.id)}>
                    {f.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
            <div className="pl-fm-modal-list">
              {moveDialogChildFolders.length === 0 && <div className="pl-empty">（此文件夹下没有子文件夹）</div>}
              {moveDialogChildFolders.map((f) => (
                <div key={f.id} className="pl-fm-modal-row" onClick={() => setMoveDialogFolderId(f.id)}>
                  <i className="fas fa-folder pl-fm-folder-glyph mr-2"></i>
                  {f.name}
                </div>
              ))}
            </div>
            <div className="d-flex justify-content-end mt-3">
              <button type="button" className="btn btn-secondary btn-sm mr-2" onClick={() => setMoveDialogOpen(false)}>
                取消
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={confirmMove}>
                移动到此处
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LessonFileManager;
