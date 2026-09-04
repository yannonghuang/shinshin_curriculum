import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mammoth from "mammoth/mammoth.browser";

import ArtifactDataService from "../services/artifact.service";
import FolderDataService from "../services/folder.service";

// A "mini cloud file system" for one 课时's 实施记录 file space (Google-Drive-
// style: whole panel is the drop target, real user-created folders, list/icon
// views, multi-select group actions) -- see folder.model.js/folder.controller.js
// for the backend side. Deliberately NOT reused for the plan-level 课程设计文件
// panel (DesignDocPanel, in plan-detail.component.js): there's no stored file
// or folder there at all -- 下载/预览 render the plan's own online content
// into a .docx on the fly, and 上传 means "replace the online content", not
// "add a file" -- a real file browser would be solving a problem that panel
// doesn't have.
//
// Folders replace category (实施记录文件/课件PPT/图片/视频) as the browsing/
// organizing structure -- category is kept only as per-file metadata (still
// auto-inferred from extension, still used for the icon and stored on the
// artifact row) since other code (AI review prompts, bulk zip import/export)
// still reads it, but nothing here groups or sections files by it anymore.
//
// Two ways to get files/folders in, both funneled through the same
// collision-aware resolve/upload helpers (resolveFolder/uploadOneFile) so
// same-name handling is identical regardless of entry point:
//  - Drag-and-drop (handleDrop): a whole dropped OS folder is read via
//    webkitGetAsEntry/FileSystemEntry (walkEntry) -- a FileSystemDirectoryEntry
//    becomes a real folder, preserving nesting; a browser without
//    webkitGetAsEntry support falls back to flat file uploads. This is the
//    only upload path that can mix loose files and whole folders in one go --
//    no browser's click-to-browse file dialog can do that (a dialog is locked
//    into either multi-*file* mode or single-*folder* mode before it even
//    opens, never both), so "上传" intentionally doesn't try to offer a
//    folder option at all; it's plain multi-file only, see below.
//  - "上传" -- a plain multi-file <input>, no folder mode.
// Same-name handling (backend enforces nothing here -- it's a pure UX
// courtesy, matching a real OS's copy-conflict dialog): a folder with the same
// name as an existing sibling is merged into it (its contents uploaded into
// the existing folder, not a new "Folder (2)"); a file with the same name as
// an existing sibling prompts to replace it (declining skips just that file).

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

// Per-file-type icon color (folder's own #e0a940 yellow, set via
// .pl-fm-folder-glyph, is the model this follows) -- extension wins over
// category so e.g. a .pdf filed under 实施记录文件 still reads as a PDF, not
// a generic document. Applied as an inline style (list view has no
// .pl-fm-icon-glyph to hook a per-type CSS class onto, and this keeps both
// views' coloring in exactly one place) rather than baking a fixed color
// into iconClassForArtifact's FontAwesome class, since the icon *shape* and
// its *color* are independent concerns.
const ARTIFACT_TYPE_COLORS = { pdf: "#e2574c", doc: "#2b579a", docx: "#2b579a", xls: "#217346", xlsx: "#217346" };
const ARTIFACT_CATEGORY_COLORS = { 视频: "#e5533c", 图片: "#00897b", 课件PPT: "#d24726" };
const iconColorForArtifact = (artifact) => {
  const type = (artifact.type || "").toLowerCase();
  return ARTIFACT_TYPE_COLORS[type] || ARTIFACT_CATEGORY_COLORS[artifact.category] || "#6c7a89";
};

// download is a public (no-auth) GET route (artifact.routes.js), so this can
// be used directly as an <img>/<video> src or a window.open target -- no need
// to fetch-as-blob first the way the old inline preview did.
const artifactUrl = (id) => `/api/artifacts/${id}/download`;

const formatBytes = (bytes) => {
  if (bytes === null || bytes === undefined) return "-";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

// Finds (to merge into) or creates the folder named `name` under
// `parentFolderId`, consulting/updating `folderCache` -- a live array the
// caller seeds from current state and this mutates in place, so collisions
// against folders created earlier in the very same batch resolve correctly
// too, not just against what the server already had.
const resolveFolder = async (name, parentFolderId, planId, lessonIndex, folderCache) => {
  const existing = folderCache.find((f) => (f.parentFolderId || null) === (parentFolderId || null) && f.name === name);
  if (existing) return existing.id;
  const created = await FolderDataService.create(planId, { lessonIndex, parentFolderId, name });
  folderCache.push(created.data);
  return created.data.id;
};

// Uploads one file into folderId; if an existing artifact already has this
// name in that folder, confirms before replacing it in place (via the update
// endpoint, so its id/history carry over) -- declining leaves the existing
// file untouched and skips this one. Returns the created/updated artifact, or
// null if skipped. artifactCache is live-mutated the same way folderCache is.
const uploadOneFile = async (file, folderId, planId, lessonIndex, artifactCache) => {
  const existing = artifactCache.find((a) => (a.folderId || null) === (folderId || null) && a.attachmentName === file.name);
  if (existing) {
    if (!window.confirm(`"${file.name}" 已存在，是否替换？`)) return null;
    const formData = new FormData();
    formData.append("file", file);
    await ArtifactDataService.update(existing.id, formData);
    const updated = { ...existing, attachmentSize: file.size, type: (file.name.split(".").pop() || "").toLowerCase() };
    artifactCache[artifactCache.indexOf(existing)] = updated;
    return updated;
  }
  const formData = new FormData();
  formData.append("description", "");
  formData.append("category", inferCategoryFromFilename(file.name));
  formData.append("lessonIndex", lessonIndex);
  if (folderId) formData.append("folderId", folderId);
  formData.append("file", file);
  const resp = await ArtifactDataService.create(planId, formData);
  const created = Array.isArray(resp.data) ? resp.data[0] : resp.data;
  artifactCache.push(created);
  return created;
};

// Walks one dropped FileSystemEntry, resolving (merging into, if a same-name
// sibling exists) a real folder for every FileSystemDirectoryEntry (nested
// ones recursively, preserving structure) and collecting { file, folderId }
// pairs for every FileSystemFileEntry -- out is populated in place so a whole
// multi-item drop shares one array.
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
const walkEntry = async (entry, parentFolderId, planId, lessonIndex, folderCache, out) => {
  if (!entry) return;
  if (entry.isFile) {
    const file = await readEntryFile(entry);
    out.push({ file, folderId: parentFolderId });
    return;
  }
  if (entry.isDirectory) {
    const newFolderId = await resolveFolder(entry.name, parentFolderId, planId, lessonIndex, folderCache);
    const children = await readAllDirectoryEntries(entry.createReader());
    // Each child folder's own creation depends on its parent already
    // existing, so this can't run in parallel across the tree.
    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop
      await walkEntry(child, newFolderId, planId, lessonIndex, folderCache, out);
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
  const fileInputRef = useRef(null);

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

  // References childFolders/childArtifacts (defined below via useMemo) --
  // safe despite the declaration order, since this closure isn't invoked
  // until a later click, well after the render that defines them has
  // finished running.
  const selectAll = () => {
    setSelectedFolderIds(new Set(childFolders.map((f) => f.id)));
    setSelectedArtifactIds(new Set(childArtifacts.map((a) => a.id)));
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

  // Drives the header checkbox replacing the old standalone "全选" button --
  // checked once every item in the current folder is selected, and toggles
  // between selectAll/clearSelection rather than only ever selecting.
  const allSelected =
    childFolders.length + childArtifacts.length > 0 &&
    selectedFolderIds.size === childFolders.length &&
    selectedArtifactIds.size === childArtifacts.length;
  const toggleSelectAll = () => {
    if (allSelected) clearSelection();
    else selectAll();
  };

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

  // Shared tail end of every upload path: takes { file, folderId } pairs
  // already resolved to their target folders and uploads each one through
  // uploadOneFile's same-name-replace-or-skip prompt.
  const uploadResolvedFiles = async (toUpload) => {
    if (toUpload.length === 0) return;
    setIsUploading(true);
    setUploadProgress(0);
    const artifactCache = [...artifacts];
    let uploadedCount = 0;
    try {
      for (let i = 0; i < toUpload.length; i += 1) {
        const { file, folderId } = toUpload[i];
        // Sequential upload mirrors the existing progress-%-per-file
        // behavior; parallel uploads would need their own progress-
        // aggregation logic for no real benefit at the file counts this
        // panel sees, and would make the replace-confirm prompts pop up out
        // of order.
        // eslint-disable-next-line no-await-in-loop
        const result = await uploadOneFile(file, folderId, planId, lessonIndex, artifactCache);
        if (result) uploadedCount += 1;
        setUploadProgress(Math.round(((i + 1) * 100) / toUpload.length));
      }
      setMessage(
        uploadedCount === toUpload.length
          ? `已上传 ${uploadedCount} 个文件。`
          : `已上传 ${uploadedCount} 个文件，跳过 ${toUpload.length - uploadedCount} 个。`
      );
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
        const folderCache = [...folders];
        // Each top-level dropped item can itself create folders the next one
        // might nest into if they share a name (unlikely, but sequential
        // keeps behavior predictable and avoids duplicate-folder races
        // either way).
        for (const entry of entries) {
          // eslint-disable-next-line no-await-in-loop
          await walkEntry(entry, currentFolderId, planId, lessonIndex, folderCache, toUpload);
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

  const handleFileInputChange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-picking the same file(s) again later
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

  // Preview opens in a new window/tab rather than inline. Can't just
  // window.open() the download URL directly -- the backend's download route
  // uses Express's res.download(), which sets Content-Disposition: attachment,
  // so the browser would silently save the file instead of ever loading it as
  // a page. Instead this fetches the bytes as a blob (same call the old inline
  // preview used) and either navigates the new window to a blob: URL --
  // browsers render an unadorned blob by its declared type (image/pdf/video/
  // audio), no attachment header involved -- or, for .docx, converts it to
  // HTML first (mammoth) and writes that directly. A window not opened until
  // after the fetch would get treated as an unrequested popup by most
  // blockers, so the blank window opens synchronously in the click handler,
  // before any await, and is only ever navigated/written into afterward.
  // No "noopener" here (unlike most window.open calls) -- this window is
  // ours, opened blank and never pointed at any third-party URL, so the
  // classic reverse-tabnabbing risk noopener guards against doesn't apply;
  // dropping it is also what lets the opener still navigate the popup to a
  // blob: URL it created -- confirmed noopener severs that relationship
  // (the popup silently stays blank otherwise).
  const openPreview = async (artifact) => {
    const ext = (artifact.attachmentName || "").toLowerCase().split(".").pop();
    const mime = artifact.attachmentMime || "application/octet-stream";
    const isDocx = ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    const win = window.open("", "_blank");
    if (win) win.document.write("<title>预览：" + artifact.attachmentName + "</title><body>预览加载中...</body>");
    try {
      const resp = await ArtifactDataService.download(artifact.id);
      if (isDocx) {
        const result = await mammoth.convertToHtml({ arrayBuffer: resp.data });
        if (win) {
          win.document.open();
          win.document.write(
            `<!doctype html><html><head><meta charset="utf-8"><title>预览：${artifact.attachmentName}</title>` +
              `<style>body{max-width:800px;margin:24px auto;padding:0 16px;font-family:sans-serif;line-height:1.6;}</style>` +
              `</head><body>${result.value || "<p>文档内容为空。</p>"}</body></html>`
          );
          win.document.close();
        }
      } else {
        const blobUrl = window.URL.createObjectURL(new Blob([resp.data], { type: mime }));
        if (win) win.location.replace(blobUrl);
      }
    } catch (e) {
      console.log(e);
      setMessage("预览失败。若为 .doc 文件，请使用下载。");
      if (win) win.close();
    }
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

  // Icon-view "nail view" thumbnail: an actual <img>/<video> for photos/
  // videos (loaded straight from the public download URL) instead of a
  // generic file-type glyph -- everything else still gets the glyph.
  const renderIconGlyphOrThumb = (artifact) => {
    if (artifact.category === "图片") {
      return <img className="pl-fm-thumb" src={artifactUrl(artifact.id)} alt={artifact.attachmentName} loading="lazy" />;
    }
    if (artifact.category === "视频") {
      // No controls/autoplay -- muted+preload=metadata just gets the browser
      // to paint the first frame as a static-looking thumbnail without
      // fetching the whole file.
      return <video className="pl-fm-thumb" src={artifactUrl(artifact.id)} muted preload="metadata" />;
    }
    return <i className={`${iconClassForArtifact(artifact)} pl-fm-icon-glyph`} style={{ color: iconColorForArtifact(artifact) }}></i>;
  };

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
        <div key={`file-${artifact.id}`} className={`pl-fm-icon-item ${checked ? "is-selected" : ""}`} onClick={() => openPreview(artifact)}>
          {canEdit && renderItemCheckbox(checked, () => toggleArtifactSelection(artifact.id))}
          {renderIconGlyphOrThumb(artifact)}
          <div className="pl-fm-icon-name" title={artifact.attachmentName}>
            {artifact.attachmentName}
          </div>
        </div>
      );
    }
    return (
      <tr key={`file-${artifact.id}`} className={checked ? "is-selected" : ""}>
        <td>{canEdit && renderItemCheckbox(checked, () => toggleArtifactSelection(artifact.id))}</td>
        <td className="pl-fm-name-cell" onClick={() => openPreview(artifact)} title={artifact.attachmentName}>
          <i className={`${iconClassForArtifact(artifact)} mr-2`} style={{ color: iconColorForArtifact(artifact) }}></i>
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
            {canEdit && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary mr-2"
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                >
                  <i className="fas fa-upload mr-1"></i>上传
                </button>
                <input ref={fileInputRef} type="file" multiple className="d-none" onChange={handleFileInputChange} />
              </>
            )}
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
                onClick={() => openPreview(childArtifacts.find((a) => selectedArtifactIds.has(a.id)))}
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
          </div>
        )}

        {message && <div className="alert alert-info py-2">{message}</div>}
        {isUploading && (
          <div className="alert alert-info py-2">上传中...{uploadProgress !== null ? `${uploadProgress}%` : ""}</div>
        )}

        {childFolders.length === 0 && childArtifacts.length === 0 ? (
          <div className="pl-fm-empty">
            {canEdit ? "此文件夹为空 -- 将文件或文件夹拖拽到此处，或点击上方“上传”" : "此文件夹为空"}
          </div>
        ) : viewMode === "list" ? (
          <table className="table table-sm table-hover pl-fm-table">
            <thead>
              <tr>
                <th style={{ width: "32px" }}>
                  {canEdit && (childFolders.length > 0 || childArtifacts.length > 0) && renderItemCheckbox(allSelected, toggleSelectAll)}
                </th>
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
