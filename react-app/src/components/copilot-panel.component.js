import React, { useEffect, useRef, useState } from "react";
import { useHistory, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import ChatDataService from "../services/chat.service";
import AuthService from "../services/auth.service";
import "../curriculum.css";

// Floating slide-in co-pilot -- mounted once in App.js for any logged-in
// user. "Session" is a conversation *scoped* to whatever the user is
// currently looking at (see chat.controller.js#deriveScopeKey) -- no
// client-side conversation-id caching, the panel always asks the backend for
// "current" (for the current scope) whenever that scope changes.
//
// planId comes from the current route (useLocation), not a prop from
// whichever page is active -- this component is mounted once, globally,
// outside any per-page tree, so reading the URL here is simpler than
// plumbing a prop through every page that might want to set it. Only
// /plans/:id is recognized today; extend the regex if other pages should
// contribute context later. reviewId, on the other hand, can't come from the
// URL (there's no /reviews/:id route) -- any component can request it via a
// "copilot:open" window event (see the listener below), e.g. a "与欣欣小助手
// 讨论这条点评" button in review-list.component.js.
const PLAN_PAGE_RE = /^\/plans\/(\d+)/;

// Default size and clamping bounds. The panel itself stays anchored via
// CSS right/bottom (see .copilot-panel) -- fixed offsets from the viewport
// edge that can never put it off-screen on that side, which is also the
// side the floating toggle button lives on. Resize handle sits at the
// panel's *top-left* corner instead of the more conventional bottom-right:
// growing a box necessarily extends away from whichever corner is fixed,
// and since right/bottom are what's fixed here, "away from that corner" is
// up-and-left -- there's plenty of room in that direction (unlike
// bottom-right, which starts already snug against the edge it's anchored
// to, leaving no room to grow there at all -- confirmed live: an earlier
// top-left-anchored version could grow height a little but not width at
// all, because its default left position was deliberately placed with zero
// slack to the right).
const PANEL_DEFAULT_WIDTH = 600;
const PANEL_DEFAULT_HEIGHT = 680;
const PANEL_MIN_WIDTH = 300;
const PANEL_MIN_HEIGHT = 360;
const PANEL_MARGIN = 20;
const PANEL_RIGHT_OFFSET = 20; // must match .copilot-panel's `right`
const PANEL_BOTTOM_OFFSET = 84; // must match .copilot-panel's `bottom`

// Coarse relative time for the history list ("刚刚"/"3小时前"/"2天前"/absolute
// date beyond a week) -- precise timestamps aren't useful there, just enough
// to tell threads apart at a glance.
const formatRelativeTime = (dateStr) => {
  if (!dateStr) return "";
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return new Date(dateStr).toLocaleDateString("zh-cn");
};

// Every action-tool entry in one message's toolCallLog (retrievedChunkIds)
// that the panel renders as a card -- a pending/settled confirm-tier action,
// a completed write that points at a plan, or a generate_document download.
// Pure lookups (search_knowledge_base etc.) stay in the 参考资料 footer instead.
const actionEntries = (message) =>
  (Array.isArray(message.retrievedChunkIds) ? message.retrievedChunkIds : []).filter(
    (e) => e && e.output && (e.output.pendingConfirmation || e.output.changed || e.output.link || e.output.document)
  );

const DOCUMENT_FORMAT_LABELS = { docx: "Word", pdf: "PDF", md: "Markdown" };

// Tells whichever page is open that 欣欣小助手 just changed data behind its
// back -- e.g. plan-detail.component.js reloads the plan it's showing (or
// warns, if it has unsaved edits of its own) instead of silently going stale.
const announceChanges = (messages) => {
  const planIds = new Set();
  let deleted = false;
  for (const m of messages) {
    for (const e of actionEntries(m)) {
      const changed = e.output.changed || (e.output.result && e.output.result.changed);
      if (!changed) continue;
      (changed.planIds || []).forEach((id) => planIds.add(Number(id)));
      if (changed.deleted) deleted = true;
    }
  }
  if (planIds.size > 0) {
    window.dispatchEvent(new CustomEvent("copilot:data-changed", { detail: { planIds: [...planIds], deleted } }));
  }
};

const ACTION_STATUS_LABELS = { pending: "待确认", confirmed: "已执行", cancelled: "已取消", failed: "执行失败" };

// A speech bubble with the letters "AI" knocked out of it (plus a small
// sparkle) -- spelling out "AI" reads at a glance in a way an abstract
// sparkles mark alone didn't. Inline SVG (FontAwesome 5's free set has
// nothing like it), drawn in currentColor with the letters cut through via a
// mask, so it works on any background. maskId must be unique per instance
// on the page.
const AiChatIcon = ({ size = 24, maskId }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <mask id={maskId}>
      <rect width="24" height="24" fill="#fff" />
      <text
        x="10"
        y="14.3"
        textAnchor="middle"
        fontSize="8.6"
        fontWeight="800"
        fontFamily="Arial, Helvetica, sans-serif"
        fill="#000"
      >
        AI
      </text>
    </mask>
    <path
      mask={`url(#${maskId})`}
      d="M4.5 4.5h11a3.5 3.5 0 0 1 3.5 3.5v6.5a3.5 3.5 0 0 1-3.5 3.5H9l-4 3.5V18h-.5A3.5 3.5 0 0 1 1 14.5V8a3.5 3.5 0 0 1 3.5-3.5z"
    />
    <path d="M20.5 .5Q20.9 3.1 23.5 3.5Q20.9 3.9 20.5 6.5Q20.1 3.9 17.5 3.5Q20.1 3.1 20.5 .5Z" />
  </svg>
);

// Import -- what the file picker offers. The old binary Office formats are
// listed on purpose: the server rejects them with a "save as .docx/.pptx"
// hint, which beats the picker silently greying them out.
const ATTACH_ACCEPT = ".docx,.pptx,.pdf,.xlsx,.txt,.md,.csv,.doc,.ppt,.xls,image/*";
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
// Images are downscaled in the browser before upload -- a phone photo or a
// retina screenshot is several MB, far more than the vision model needs to
// read it, and it's stored and replayed into Word exports afterwards.
const IMAGE_MAX_EDGE = 1600;
const IMAGE_KEEP_ORIGINAL_BYTES = 1.5 * 1024 * 1024;

const isImageFile = (file) => (file.type || "").startsWith("image/");

const loadImage = (file) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取该图片。"));
    };
    img.src = url;
  });

// -> { file, width, height }. A PNG/JPEG already small enough is sent as-is
// (a PNG screenshot of text stays crisp); anything else is redrawn onto a
// canvas no larger than IMAGE_MAX_EDGE and re-encoded as JPEG.
const prepareImage = async (file) => {
  const img = await loadImage(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.round(img.naturalWidth * scale);
  const height = Math.round(img.naturalHeight * scale);
  if (scale === 1 && file.size <= IMAGE_KEEP_ORIGINAL_BYTES && /^image\/(png|jpeg)$/.test(file.type)) {
    return { file, width, height };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNG regions would turn black in JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  const baseName = (file.name || "图片").replace(/\.[^.]+$/, "");
  return { file: new File([blob], `${baseName}.jpg`, { type: "image/jpeg" }), width, height };
};

// A pasted screenshot arrives as a nameless "image.png" -- give it a name the
// teacher can tell apart in the chip and in an export.
const namePastedFile = (file) => {
  if (file.name && file.name !== "image.png") return file;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return new File([file], `粘贴图片-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`, { type: file.type });
};

// Which pastes are attachments: clipboard files *without* accompanying text.
// Copying text out of Word/WPS also puts a picture of the selection on the
// clipboard -- that paste should be the text, not an image of it. Copying a
// file in Finder/Explorer carries its own filename as the text, which still
// counts as a file paste.
const pastedFiles = (clipboardData) => {
  const files = Array.from((clipboardData && clipboardData.files) || []);
  if (files.length === 0) return [];
  const text = (clipboardData.getData("text/plain") || "").trim();
  if (text && !files.some((f) => f.name === text)) return [];
  return files;
};

// An axios blob request's error body is a Blob too -- pull the JSON
// { message } back out of it.
const blobErrorMessage = async (err, fallback) => {
  const data = err && err.response && err.response.data;
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text()).message || fallback;
    } catch (e) {
      return fallback;
    }
  }
  return (data && data.message) || fallback;
};

const filenameFromDisposition = (header, fallback) => {
  const match = /filename\*=UTF-8''([^;]+)/i.exec(header || "");
  return match ? decodeURIComponent(match[1]) : fallback;
};

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// Prints server-rendered transcript HTML (→ the browser's 另存为 PDF) from a
// hidden iframe that may not run scripts -- the HTML can echo text from an
// uploaded file, so it gets no script execution even though it's already
// escaped server-side (copilotExport.js#htmlMarked).
const printHtml = (html) =>
  new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    iframe.onload = () => {
      // Images are inline data URLs, so they're loaded by now.
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => {
        iframe.remove();
        resolve();
      }, 1000);
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });

const formatFileSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;

// Thumbnail of a sent image attachment -- fetched with the auth header as a
// blob (a bare <img src> can't carry it). `localUrl` short-circuits the fetch
// for the optimistic bubble, which still has the teacher's own local copy.
const AttachmentImage = ({ id, name, localUrl }) => {
  const [url, setUrl] = useState(localUrl || null);
  useEffect(() => {
    if (localUrl || !id) return undefined;
    let objectUrl = null;
    let cancelled = false;
    ChatDataService.getAttachmentImage(id)
      .then((resp) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(resp.data);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, localUrl]);
  if (!url) return <div className="copilot-attachment-thumb copilot-attachment-thumb-loading"></div>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={name}>
      <img className="copilot-attachment-thumb" src={url} alt={name} />
    </a>
  );
};

// A message's attachments as shown in its bubble: images as thumbnails,
// documents as file chips.
const MessageAttachments = ({ attachments }) => {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="copilot-message-attachments">
      {attachments.map((a) =>
        a.kind === "image" ? (
          <AttachmentImage key={a.id || a.name} id={a.id} name={a.name} localUrl={a.previewUrl} />
        ) : (
          <div key={a.id || a.name} className="copilot-attachment-file" title={a.name}>
            <i className="fas fa-file-alt"></i> <span>{a.name}</span>
          </div>
        )
      )}
    </div>
  );
};

const CopilotPanel = () => {
  const location = useLocation();
  const history = useHistory();
  // `${messageId}:${actionId}` while its 确认/取消 request is in flight.
  const [actionBusyKey, setActionBusyKey] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  // Keyed by message id (or the same fallback key used for React's `key`
  // prop below) -- lets the copy button grab the already-markdown-rendered
  // DOM node for that exact bubble without re-deriving HTML from scratch.
  const messageContentRefs = useRef({});
  const [copiedKey, setCopiedKey] = useState(null);
  const [panelSize, setPanelSize] = useState({ width: PANEL_DEFAULT_WIDTH, height: PANEL_DEFAULT_HEIGHT });
  const panelRef = useRef(null);
  // Only populated while an actual drag is in progress -- see
  // onResizeMouseDown/Move/Up below. Not React state: every mousemove during
  // a drag mutates panelRef's DOM node directly (no re-render per pixel
  // moved), and panelSize only gets its one state update on mouseup, once
  // the final size is known.
  const resizeStateRef = useRef(null);

  // Custom drag-to-resize handle (see .copilot-resize-handle), not the
  // native CSS `resize` property -- that was tried first and turned out
  // unreliable in practice (a real user could only ever shrink the panel,
  // never grow it, for reasons that didn't reproduce in an automated
  // same-browser drag simulation -- rather than keep chasing a browser-
  // specific native-resize quirk, this gives full, predictable control).
  const onResizeMouseMove = (e) => {
    const state = resizeStateRef.current;
    const panel = panelRef.current;
    if (!state || !panel) return;
    // Dragging the top-left grip up/left grows the box (moving away from
    // the fixed bottom-right corner), so width/height move *opposite* to
    // the mouse delta here, unlike a conventional bottom-right handle.
    const maxWidth = window.innerWidth - PANEL_RIGHT_OFFSET - PANEL_MARGIN;
    const maxHeight = window.innerHeight - PANEL_BOTTOM_OFFSET - PANEL_MARGIN;
    const newWidth = Math.min(Math.max(state.startWidth - (e.clientX - state.startX), PANEL_MIN_WIDTH), maxWidth);
    const newHeight = Math.min(Math.max(state.startHeight - (e.clientY - state.startY), PANEL_MIN_HEIGHT), maxHeight);
    panel.style.width = `${newWidth}px`;
    panel.style.height = `${newHeight}px`;
  };

  const onResizeMouseUp = () => {
    const panel = panelRef.current;
    if (panel) {
      setPanelSize({ width: panel.offsetWidth, height: panel.offsetHeight });
    }
    resizeStateRef.current = null;
    document.removeEventListener("mousemove", onResizeMouseMove);
    document.removeEventListener("mouseup", onResizeMouseUp);
  };

  const onResizeMouseDown = (e) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    resizeStateRef.current = { startX: e.clientX, startY: e.clientY, startWidth: rect.width, startHeight: rect.height };
    document.addEventListener("mousemove", onResizeMouseMove);
    document.addEventListener("mouseup", onResizeMouseUp);
  };

  const currentUser = AuthService.getCurrentUser();
  const isLoggedIn = !!currentUser;
  const displayName = currentUser && (currentUser.chineseName || currentUser.username);

  const [overrideReviewId, setOverrideReviewId] = useState(null);
  // Set when the user explicitly picks a past thread from "历史" (see
  // openThread below) -- takes priority over scope-derived "current" for
  // both loading and sending: that thread's own stored context is what
  // answers apply to, not wherever the user happens to be browsing (see
  // chat.controller.js#sendMessageToConversation). Cleared on close, on
  // "新对话", and by the explicit "返回当前对话" link -- never silently, since
  // the whole point of picking a thread is that it stays put until the user
  // deliberately leaves it.
  const [explicitConversationId, setExplicitConversationId] = useState(null);
  const [viewMode, setViewMode] = useState("chat"); // "chat" | "history"
  const [historyList, setHistoryList] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  // The conversation the messages on screen belong to -- what 导出 exports.
  // Whichever endpoint last returned it (current/by-id/new/send) wins.
  const [conversationId, setConversationId] = useState(null);

  // Import: chips above the input for files picked/pasted/dropped but not
  // yet sent -- { key, name, kind, size, status: "uploading" | "ready" |
  // "error", id?, warning?, error?, previewUrl? (images: a local object URL) }.
  const [pendingAttachments, setPendingAttachments] = useState([]);
  // Chips removed while their upload was still in flight -- the upload's
  // result is deleted server-side as soon as it lands instead of shown.
  const discardedUploadKeysRef = useRef(new Set());
  const fileInputRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Export: exportScope "all" = the whole conversation server-side (older
  // messages beyond what the panel has loaded included); "selected" = only
  // the ticked bubbles.
  const [isExportMode, setIsExportMode] = useState(false);
  const [exportScope, setExportScope] = useState("all");
  const [selectedMessageIds, setSelectedMessageIds] = useState(() => new Set());
  const [exportingFormat, setExportingFormat] = useState(null);

  // Listens for e.g. review-list.component.js's "discuss this review"
  // button -- window.dispatchEvent(new CustomEvent("copilot:open", { detail:
  // { reviewId } })) opens the panel scoped to that review, layered on top
  // of (not replacing) whatever planId the URL already contributes.
  useEffect(() => {
    const onOpenRequest = (e) => {
      if (e.detail && e.detail.reviewId) setOverrideReviewId(e.detail.reviewId);
      setIsOpen(true);
    };
    window.addEventListener("copilot:open", onOpenRequest);
    return () => window.removeEventListener("copilot:open", onOpenRequest);
  }, []);

  // Leaving the page (any navigation) ends that specific review discussion --
  // the override doesn't follow the user to an unrelated page.
  useEffect(() => {
    setOverrideReviewId(null);
  }, [location.pathname]);

  const pageContext = (() => {
    const match = PLAN_PAGE_RE.exec(location.pathname);
    const planId = match ? Number(match[1]) : undefined;
    if (!planId && !overrideReviewId) return undefined;
    return { planId, reviewId: overrideReviewId || undefined };
  })();

  // Mirrors chat.controller.js#deriveScopeKey -- just used as an effect
  // dependency below, so switching scope (navigating to a different plan, or
  // opening a different review's discussion) reloads "current" for the new
  // scope instead of silently keeping whatever was already loaded.
  const scopeKeyClient = pageContext
    ? pageContext.reviewId
      ? `review:${pageContext.reviewId}`
      : pageContext.planId
      ? `plan:${pageContext.planId}`
      : null
    : null;

  const loadCurrent = async () => {
    try {
      const resp = explicitConversationId
        ? await ChatDataService.getConversationById(explicitConversationId)
        : await ChatDataService.getCurrent(pageContext);
      setMessages(resp.data.messages || []);
      setConversationId(resp.data.conversation ? resp.data.conversation.id : null);
      setIsLoaded(true);
    } catch (e) {
      console.log(e);
      setError("加载对话失败。");
    }
  };

  useEffect(() => {
    if (isOpen && viewMode === "chat") {
      setIsLoaded(false);
      loadCurrent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scopeKeyClient, explicitConversationId, viewMode]);

  // Closing the panel ends any explicitly-picked thread -- reopening (maybe
  // much later, on a different page) should show whatever's current for
  // wherever the user is by then, not silently resurrect an old pick.
  useEffect(() => {
    if (!isOpen) {
      setExplicitConversationId(null);
        setViewMode("chat");
      setIsExportMode(false);
    }
  }, [isOpen]);

  // Switching to another conversation (scope change, 历史, 新对话) leaves
  // export mode -- its selection referred to the previous one's messages.
  useEffect(() => {
    setIsExportMode(false);
  }, [conversationId, viewMode]);

  const openHistory = async () => {
    setViewMode("history");
    setIsLoadingHistory(true);
    try {
      const resp = await ChatDataService.listConversations();
      setHistoryList(resp.data || []);
    } catch (e) {
      console.log(e);
      setError("加载历史对话失败。");
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const openThread = (id) => {
    setExplicitConversationId(id);
    setViewMode("chat");
  };

  const returnToCurrent = () => {
    setExplicitConversationId(null);
  };

  const deleteThread = async (id) => {
    if (!window.confirm("确定删除这条历史对话吗？此操作无法撤销。")) return;
    try {
      await ChatDataService.deleteConversation(id);
      setHistoryList((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
      // Deleting the thread currently open elsewhere in the panel -- snap
      // back to whatever's current for the page rather than leaving a
      // reference to a conversation that no longer exists.
      if (explicitConversationId === id) {
        setExplicitConversationId(null);
      }
    } catch (err) {
      setError(err?.response?.data?.message || "删除对话失败。");
    }
  };

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // The input grows with what's typed (up to .copilot-input's max-height,
  // then scrolls) and shrinks back to one line once sent/cleared.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`; // + top/bottom border
  }, [input, isOpen, viewMode, isExportMode]);

  // Back to the input once a reply lands -- it was disabled while sending,
  // which drops focus.
  useEffect(() => {
    if (!isSending && isOpen && inputRef.current) inputRef.current.focus();
  }, [isSending, isOpen]);

  if (!isLoggedIn) return null;

  const isUploading = pendingAttachments.some((a) => a.status === "uploading");
  const readyAttachments = pendingAttachments.filter((a) => a.status === "ready");

  const send = async (e) => {
    e.preventDefault();
    const content = input.trim();
    if ((!content && readyAttachments.length === 0) || isSending || isUploading) return;
    const sentAttachments = readyAttachments;
    const keptAttachments = pendingAttachments;
    setInput("");
    setPendingAttachments([]);
    setError("");
    // Optimistic append -- the real row (with its real id/timestamp) replaces
    // this once the request returns; a failure just leaves it in place with
    // an error message below rather than silently discarding what was typed.
    setMessages((prev) => [...prev, { role: "user", content, attachments: sentAttachments, _pending: true }]);
    setIsSending(true);
    const attachmentIds = sentAttachments.map((a) => a.id);
    try {
      const resp = explicitConversationId
        ? await ChatDataService.sendMessageToConversation(explicitConversationId, content, attachmentIds)
        : await ChatDataService.sendMessage(content, pageContext, attachmentIds);
      setMessages((prev) => {
        const withoutPending = prev.filter((m) => !m._pending);
        return [...withoutPending, resp.data.userMessage, resp.data.assistantMessage];
      });
      if (resp.data.conversation) setConversationId(resp.data.conversation.id);
      announceChanges([resp.data.assistantMessage]);
      sentAttachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    } catch (err) {
      // 422 = rejected before anything was stored (e.g. an attachment that
      // expired) -- hand the draft back instead of leaving a ghost bubble.
      if (err?.response?.status === 422) {
        setMessages((prev) => prev.filter((m) => !m._pending));
        setInput(content);
        setPendingAttachments(keptAttachments);
      }
      setError(err?.response?.data?.message || "发送失败，请重试。");
    } finally {
      setIsSending(false);
    }
  };

  // Enter sends, Shift+Enter is a newline -- the usual AI-chat convention.
  // Not while an IME is composing: with pinyin input, Enter confirms the
  // candidate text, and sending then would fire off a half-typed message.
  // (keyCode 229 covers browsers that end composition before keydown.)
  const onInputKeyDown = (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send(e);
  };

  // ---------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------
  const patchAttachment = (key, patch) =>
    setPendingAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const uploadOne = async (rawFile) => {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isImage = isImageFile(rawFile);
    setPendingAttachments((prev) => [
      ...prev,
      { key, name: rawFile.name, kind: isImage ? "image" : "document", size: rawFile.size, status: "uploading", progress: 0 },
    ]);
    try {
      let file = rawFile;
      let dims = {};
      if (isImage) {
        const prepared = await prepareImage(rawFile);
        file = prepared.file;
        dims = { width: prepared.width, height: prepared.height };
        patchAttachment(key, { name: file.name, size: file.size, previewUrl: URL.createObjectURL(file) });
      }
      const resp = await ChatDataService.uploadAttachment(file, dims, (evt) => {
        if (evt.total) patchAttachment(key, { progress: Math.round((evt.loaded / evt.total) * 100) });
      });
      if (discardedUploadKeysRef.current.has(key)) {
        discardedUploadKeysRef.current.delete(key);
        ChatDataService.deleteAttachment(resp.data.id).catch(() => {});
        return;
      }
      patchAttachment(key, { status: "ready", id: resp.data.id, warning: resp.data.warning, chars: resp.data.chars });
    } catch (err) {
      patchAttachment(key, { status: "error", error: err?.response?.data?.message || err.message || "上传失败。" });
    }
  };

  const addFiles = (files) => {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    setError("");
    const room = MAX_ATTACHMENTS_PER_MESSAGE - pendingAttachments.length;
    if (room <= 0) {
      setError(`每条消息最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件。`);
      return;
    }
    if (list.length > room) setError(`每条消息最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件，多出的文件已忽略。`);
    list.slice(0, room).forEach(uploadOne);
  };

  const removeAttachment = (a) => {
    if (a.status === "uploading") discardedUploadKeysRef.current.add(a.key);
    if (a.status === "ready" && a.id) ChatDataService.deleteAttachment(a.id).catch(() => {});
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setPendingAttachments((prev) => prev.filter((x) => x.key !== a.key));
  };

  const onPaste = (e) => {
    const files = pastedFiles(e.clipboardData);
    if (files.length === 0) return; // ordinary text paste
    e.preventDefault();
    addFiles(files.map(namePastedFile));
  };

  const hasDraggedFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");

  const onDragOver = (e) => {
    if (viewMode !== "chat" || isExportMode || !hasDraggedFiles(e)) return;
    e.preventDefault();
    if (!isDragOver) setIsDragOver(true);
  };

  const onDragLeave = (e) => {
    // dragleave also fires when crossing into a child -- only clear once the
    // pointer has actually left the panel.
    if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOver(false);
  };

  const onDrop = (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    setIsDragOver(false);
    if (viewMode !== "chat" || isExportMode) return;
    addFiles(e.dataTransfer.files);
  };

  // ---------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------
  const exportableMessages = messages.filter((m) => m.id && !m._pending && (m.role === "user" || m.role === "assistant"));

  const enterExportMode = () => {
    setExportScope("all");
    setSelectedMessageIds(new Set(exportableMessages.map((m) => m.id)));
    setIsExportMode(true);
    setError("");
  };

  const toggleSelected = (id) =>
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runExport = async (format) => {
    if (!conversationId || exportingFormat) return;
    const messageIds = exportScope === "selected" ? exportableMessages.filter((m) => selectedMessageIds.has(m.id)).map((m) => m.id) : undefined;
    if (messageIds && messageIds.length === 0) {
      setError("请至少选择一条消息。");
      return;
    }
    setExportingFormat(format);
    setError("");
    try {
      const resp = await ChatDataService.exportConversation(conversationId, format === "pdf" ? "html" : format, messageIds);
      if (format === "pdf") {
        await printHtml(await resp.data.text());
      } else {
        downloadBlob(resp.data, filenameFromDisposition(resp.headers["content-disposition"], `欣欣小助手对话.${format}`));
      }
      setIsExportMode(false);
    } catch (err) {
      setError(await blobErrorMessage(err, "导出失败，请重试。"));
    } finally {
      setExportingFormat(null);
    }
  };

  // 确认执行/取消 on a pending action -- the server runs it (or not) and
  // returns the proposing message with its status updated, plus a follow-up
  // assistant message recording the outcome.
  const settleAction = async (message, actionId, confirm) => {
    const busyKey = `${message.id}:${actionId}`;
    if (actionBusyKey) return;
    setActionBusyKey(busyKey);
    setError("");
    try {
      const resp = confirm
        ? await ChatDataService.confirmAction(message.id, actionId)
        : await ChatDataService.cancelAction(message.id, actionId);
      setMessages((prev) => [...prev.map((m) => (m.id === resp.data.message.id ? resp.data.message : m)), resp.data.followUp]);
      if (confirm) announceChanges([resp.data.followUp]);
    } catch (err) {
      setError(err?.response?.data?.message || "操作失败，请重试。");
    } finally {
      setActionBusyKey(null);
    }
  };

  // 下载 on a generate_document card -- rendered server-side on each click
  // (see chat.controller.js#downloadDocument); pdf arrives as HTML to print.
  const downloadDocument = async (message, doc) => {
    const busyKey = `${message.id}:doc:${doc.docId}`;
    if (actionBusyKey) return;
    setActionBusyKey(busyKey);
    setError("");
    try {
      const resp = await ChatDataService.downloadDocument(message.id, doc.docId);
      if (doc.format === "pdf") {
        await printHtml(await resp.data.text());
      } else {
        downloadBlob(resp.data, filenameFromDisposition(resp.headers["content-disposition"], `${doc.title}.${doc.format}`));
      }
    } catch (err) {
      setError(await blobErrorMessage(err, "下载失败，请重试。"));
    } finally {
      setActionBusyKey(null);
    }
  };

  const renderActions = (message) => {
    const entries = actionEntries(message);
    if (entries.length === 0) return null;
    // One "打开《…》" per plan per message -- a turn often reads a plan
    // (get_plan_details) and then edits it (update_plan).
    const linkedPlanIds = new Set();
    return entries.map((e, i) => {
      const o = e.output;
      let link = o.link || (o.result && o.result.link);
      if (link && linkedPlanIds.has(link.id)) link = null;
      if (link) linkedPlanIds.add(link.id);
      if (o.document) {
        const doc = o.document;
        const busy = actionBusyKey === `${message.id}:doc:${doc.docId}`;
        return (
          <div key={`${e.name}-${i}`} className="copilot-action">
            <div className="copilot-action-summary">
              <i className="fas fa-file-download"></i> {doc.title}（{DOCUMENT_FORMAT_LABELS[doc.format] || doc.format}）
            </div>
            <div className="copilot-action-buttons">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!!actionBusyKey}
                onClick={() => downloadDocument(message, doc)}
              >
                {busy ? "生成中..." : doc.format === "pdf" ? "打印 / 另存为 PDF" : "下载"}
              </button>
            </div>
          </div>
        );
      }
      if (!link && !o.pendingConfirmation) return null;
      const deleted = (o.changed && o.changed.deleted) || (o.result && o.result.changed && o.result.changed.deleted);
      const busy = actionBusyKey === `${message.id}:${o.actionId}`;
      return (
        <div key={`${e.name}-${i}`} className="copilot-action">
          {o.pendingConfirmation && (
            <>
              <div className="copilot-action-summary">
                <span className={`copilot-action-status copilot-action-status-${o.status}`}>
                  {ACTION_STATUS_LABELS[o.status] || o.status}
                </span>
                {o.summary}
              </div>
              {o.status === "failed" && o.error && <div className="copilot-action-error">{o.error}</div>}
              {o.status === "pending" && (
                <div className="copilot-action-buttons">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!!actionBusyKey}
                    onClick={() => settleAction(message, o.actionId, true)}
                  >
                    {busy ? "执行中..." : "确认执行"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    disabled={!!actionBusyKey}
                    onClick={() => settleAction(message, o.actionId, false)}
                  >
                    取消
                  </button>
                </div>
              )}
            </>
          )}
          {link && link.type === "plan" && !deleted && (
            <button type="button" className="btn btn-sm btn-link p-0 copilot-action-link" onClick={() => history.push(`/plans/${link.id}`)}>
              <i className="fas fa-external-link-alt"></i> 打开《{link.title}》
            </button>
          )}
        </div>
      );
    });
  };

  const startNew = async () => {
    try {
      setExplicitConversationId(null);
        setViewMode("chat");
      const resp = await ChatDataService.startNew(pageContext);
      setConversationId(resp.data.conversation ? resp.data.conversation.id : null);
      setMessages([]);
      setError("");
    } catch (err) {
      setError(err?.response?.data?.message || "新建对话失败。");
    }
  };

  // Citation footer -- retrievedChunkIds is the agent loop's own
  // toolCallLog, an array of { name, arguments, output } per tool call this
  // turn. search_knowledge_base's output is { context, sources: [{ title,
  // locator }] } (knowledge-tree retrieval, see backend
  // knowledgeRetrieve.js#searchKnowledgeTree); messages stored before that
  // have a plain array of keyword hits instead, still handled here. Only
  // shown when the tool actually returned something.
  const renderCitations = (message) => {
    const log = message.retrievedChunkIds;
    if (!Array.isArray(log) || log.length === 0) return null;
    const titles = log
      .flatMap((call) => {
        const out = call.output;
        if (Array.isArray(out)) return out.map((hit) => hit.title || (hit.content || "").slice(0, 20));
        if (out && Array.isArray(out.sources)) return out.sources.map((s) => `《${s.title}》${s.locator ? s.locator : ""}`);
        return [];
      })
      .filter(Boolean);
    if (titles.length === 0) return null;
    return (
      <div className="copilot-citations">
        参考资料：{[...new Set(titles)].join("、")}
      </div>
    );
  };

  // Copies both the rendered formatting (as HTML, so pasting into e.g. a
  // doc or email keeps headings/bold/lists) and a plain-text fallback in the
  // same clipboard write -- the target app picks whichever it understands.
  // Falls back to plain text alone when the browser lacks the multi-type
  // Clipboard API (e.g. older Safari).
  const copyMessage = async (key) => {
    const node = messageContentRefs.current[key];
    if (!node) return;
    const html = node.innerHTML;
    const text = node.innerText;
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new window.ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500);
    } catch (err) {
      console.log(err);
    }
  };

  const currentThreadLabel = historyList && explicitConversationId
    ? (historyList.find((c) => c.id === explicitConversationId) || {}).label
    : null;

  return (
    <div className="copilot-root">
      <button
        type="button"
        className="copilot-toggle"
        onClick={() => setIsOpen((prev) => !prev)}
        title={isOpen ? "关闭欣欣小助手" : "打开欣欣小助手"}
      >
        {/* key'd spans -- FontAwesome's JS swaps <i> for <svg>, see the attachment-chip note */}
        {isOpen ? (
          <span key="close">
            <i className="fas fa-times"></i>
          </span>
        ) : (
          <span key="open" className="copilot-toggle-icon">
            <AiChatIcon size={30} maskId="copilot-ai-mask-toggle" />
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className="copilot-panel"
          ref={panelRef}
          style={{ width: panelSize.width, height: panelSize.height }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div className="copilot-resize-handle" onMouseDown={onResizeMouseDown} title="拖动调整大小"></div>
          {isDragOver && (
            <div className="copilot-drop-overlay">
              <i className="fas fa-file-upload"></i>
              <div>松开即可添加为附件</div>
            </div>
          )}
          <div className="copilot-header">
            <span className="copilot-title">
              <AiChatIcon size={20} maskId="copilot-ai-mask-header" />
              欣欣小助手
            </span>
            <div>
              {viewMode === "chat" && (
                <button
                  type="button"
                  className="btn btn-sm btn-link copilot-new-btn"
                  disabled={!conversationId || exportableMessages.length === 0}
                  title="将对话导出为 Word / Markdown / PDF"
                  onClick={() => (isExportMode ? setIsExportMode(false) : enterExportMode())}
                >
                  导出
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-link copilot-new-btn"
                onClick={() => (viewMode === "history" ? setViewMode("chat") : openHistory())}
              >
                {viewMode === "history" ? "返回" : "历史"}
              </button>
              <button type="button" className="btn btn-sm btn-link copilot-new-btn" onClick={startNew}>
                新对话
              </button>
            </div>
          </div>

          {viewMode === "history" ? (
            <div className="copilot-messages">
              {isLoadingHistory && <div className="pl-empty">加载中...</div>}
              {!isLoadingHistory && historyList && historyList.length === 0 && <div className="pl-empty">暂无历史对话。</div>}
              {!isLoadingHistory &&
                historyList &&
                historyList.map((c) => (
                  <div key={c.id} className="copilot-history-item" onClick={() => openThread(c.id)}>
                    <button
                      type="button"
                      className="btn btn-sm btn-link text-danger copilot-history-delete"
                      title="删除这条历史对话"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteThread(c.id);
                      }}
                    >
                      删除
                    </button>
                    <div className="copilot-history-label">{c.label}</div>
                    {c.title && <div className="copilot-history-title">{c.title}</div>}
                    <div className="copilot-history-time">{formatRelativeTime(c.lastActivity)}</div>
                  </div>
                ))}
            </div>
          ) : (
            <>
              {explicitConversationId && (
                <div className="copilot-thread-banner">
                  正在查看：{currentThreadLabel || "历史对话"}
                  <button type="button" className="btn btn-sm btn-link p-0 ml-2" onClick={returnToCurrent}>
                    返回当前对话
                  </button>
                </div>
              )}
              <div className="copilot-messages">
                {!isLoaded && <div className="pl-empty">加载中...</div>}
                {isLoaded && messages.length === 0 && (
                  <div className="pl-empty">{displayName ? `${displayName}，有什么可以帮您的？` : "有什么可以帮您的？"}</div>
                )}
                {messages.map((m, i) => {
                  const key = m.id || `pending-${i}`;
                  const selectable = isExportMode && exportScope === "selected" && m.id && !m._pending;
                  const selected = selectable && selectedMessageIds.has(m.id);
                  return (
                    <div
                      key={key}
                      className={`copilot-bubble copilot-bubble-${m.role}${selectable ? " copilot-bubble-selectable" : ""}${
                        selected ? " copilot-bubble-selected" : ""
                      }`}
                      onClick={selectable ? () => toggleSelected(m.id) : undefined}
                    >
                      {selectable && (
                        <input
                          type="checkbox"
                          className="copilot-select-box"
                          checked={!!selected}
                          onChange={() => toggleSelected(m.id)}
                          onClick={(e) => e.stopPropagation()}
                          title="选择这条消息导出"
                        />
                      )}
                      {m.role === "assistant" && !m._pending && !isExportMode && (
                        <button
                          type="button"
                          className="copilot-copy-btn"
                          title="复制"
                          onClick={() => copyMessage(key)}
                        >
                          <i className={`fas fa-${copiedKey === key ? "check" : "copy"}`}></i>
                        </button>
                      )}
                      {m.role === "assistant" ? (
                        <div
                          className="copilot-bubble-content copilot-markdown"
                          ref={(el) => (messageContentRefs.current[key] = el)}
                        >
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <>
                          {m.content && <div className="copilot-bubble-content">{m.content}</div>}
                          <MessageAttachments attachments={m.attachments} />
                        </>
                      )}
                      {m.role === "assistant" && renderActions(m)}
                      {m.role === "assistant" && renderCitations(m)}
                    </div>
                  );
                })}
                {isSending && (
                  <div className="copilot-bubble copilot-bubble-assistant copilot-bubble-thinking">
                    <div className="copilot-bubble-content">思考中...</div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {error && <div className="alert alert-info py-1 px-2 copilot-error">{error}</div>}

              {isExportMode ? (
                <div className="copilot-export-bar">
                  <div className="copilot-export-scope">
                    <label>
                      <input type="radio" checked={exportScope === "all"} onChange={() => setExportScope("all")} /> 整段对话
                    </label>
                    <label>
                      <input type="radio" checked={exportScope === "selected"} onChange={() => setExportScope("selected")} /> 选择部分消息
                    </label>
                    {exportScope === "selected" && (
                      <span className="copilot-export-count">
                        已选 {exportableMessages.filter((m) => selectedMessageIds.has(m.id)).length} 条
                        <button
                          type="button"
                          className="btn btn-sm btn-link p-0 ml-2"
                          onClick={() => setSelectedMessageIds(new Set(exportableMessages.map((m) => m.id)))}
                        >
                          全选
                        </button>
                        <button type="button" className="btn btn-sm btn-link p-0 ml-2" onClick={() => setSelectedMessageIds(new Set())}>
                          清空
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="copilot-export-actions">
                    <span>导出为：</span>
                    {[
                      ["docx", "Word"],
                      ["md", "Markdown"],
                      ["pdf", "PDF"],
                    ].map(([format, label]) => (
                      <button
                        key={format}
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={!!exportingFormat}
                        title={format === "pdf" ? "打开打印对话框，选择「另存为 PDF」" : undefined}
                        onClick={() => runExport(format)}
                      >
                        {exportingFormat === format ? "生成中..." : label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-secondary"
                      disabled={!!exportingFormat}
                      onClick={() => setIsExportMode(false)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="copilot-composer">
                  {pendingAttachments.length > 0 && (
                    <div className="copilot-pending-attachments">
                      {pendingAttachments.map((a) => (
                        <div
                          key={a.key}
                          className={`copilot-chip copilot-chip-${a.status}${a.warning ? " copilot-chip-warning" : ""}`}
                          title={a.error || a.warning || `${a.name}（${formatFileSize(a.size)}）`}
                        >
                          {/* Icons sit in a <span> React owns: App.js loads FontAwesome's JS, which swaps
                              each <i> for an <svg> behind React's back, so React can't later remove an <i>
                              it rendered conditionally (removeChild crash) -- it removes the span instead. */}
                          {a.previewUrl ? (
                            <img className="copilot-chip-thumb" src={a.previewUrl} alt="" />
                          ) : (
                            <span>
                              <i className={`fas fa-${a.kind === "image" ? "image" : "file-alt"}`}></i>
                            </span>
                          )}
                          <span className="copilot-chip-name">{a.name}</span>
                          <span className="copilot-chip-status">
                            {a.status === "uploading" &&
                              (a.progress < 100 ? `上传 ${a.progress || 0}%` : a.kind === "image" ? "识别中..." : "解析中...")}
                            {a.status === "error" && "失败"}
                            {a.status === "ready" && a.warning && (
                              <span>
                                <i className="fas fa-exclamation-triangle"></i>
                              </span>
                            )}
                          </span>
                          <button type="button" className="copilot-chip-remove" title="移除" onClick={() => removeAttachment(a)}>
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <form className="copilot-input-row" onSubmit={send}>
                    <button
                      type="button"
                      className="btn btn-outline-secondary copilot-attach-btn"
                      title="添加附件（Word、PPT、PDF、Excel、文本或图片；也可直接粘贴截图或拖入文件）"
                      disabled={isSending}
                      onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    >
                      <i className="fas fa-paperclip"></i>
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept={ATTACH_ACCEPT}
                      style={{ display: "none" }}
                      onChange={(e) => {
                        addFiles(e.target.files);
                        e.target.value = ""; // so picking the same file again still fires onChange
                      }}
                    />
                    <textarea
                      ref={inputRef}
                      rows={1}
                      className="form-control copilot-input"
                      placeholder={
                        pendingAttachments.length > 0 ? "说明需要如何处理附件（可不填）..." : "输入问题，或粘贴截图（Shift+Enter 换行）..."
                      }
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={onInputKeyDown}
                      onPaste={onPaste}
                      disabled={isSending}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary copilot-send-btn"
                      disabled={isSending || isUploading || (!input.trim() && readyAttachments.length === 0)}
                      title={isUploading ? "附件处理中，请稍候" : "发送（Enter）"}
                      aria-label="发送"
                    >
                      {/* key'd spans, not bare <i>s -- see the FontAwesome note on the attachment chips */}
                      {isSending ? (
                        <span key="sending">
                          <i className="fas fa-spinner fa-spin"></i>
                        </span>
                      ) : (
                        <span key="send">
                          <i className="fas fa-arrow-up"></i>
                        </span>
                      )}
                    </button>
                  </form>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default CopilotPanel;
