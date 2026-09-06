import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

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
// "copilot:open" window event (see the listener below), e.g. a "与欣欣助手
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
const PANEL_DEFAULT_WIDTH = 360;
const PANEL_DEFAULT_HEIGHT = 520;
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

const CopilotPanel = () => {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef(null);
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
    }
  }, [isOpen]);

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

  if (!isLoggedIn) return null;

  const send = async (e) => {
    e.preventDefault();
    const content = input.trim();
    if (!content || isSending) return;
    setInput("");
    setError("");
    // Optimistic append -- the real row (with its real id/timestamp) replaces
    // this once the request returns; a failure just leaves it in place with
    // an error message below rather than silently discarding what was typed.
    setMessages((prev) => [...prev, { role: "user", content, _pending: true }]);
    setIsSending(true);
    try {
      const resp = explicitConversationId
        ? await ChatDataService.sendMessageToConversation(explicitConversationId, content)
        : await ChatDataService.sendMessage(content, pageContext);
      setMessages((prev) => {
        const withoutPending = prev.filter((m) => !m._pending);
        return [...withoutPending, resp.data.userMessage, resp.data.assistantMessage];
      });
    } catch (err) {
      setError(err?.response?.data?.message || "发送失败，请重试。");
    } finally {
      setIsSending(false);
    }
  };

  const startNew = async () => {
    try {
      setExplicitConversationId(null);
      setViewMode("chat");
      await ChatDataService.startNew(pageContext);
      setMessages([]);
      setError("");
    } catch (err) {
      setError(err?.response?.data?.message || "新建对话失败。");
    }
  };

  // Citation footer -- retrievedChunkIds is the agent loop's own
  // toolCallLog, an array of { name, arguments, output: [...] } per tool
  // call this turn. Only ever shown when the tool actually returned
  // something (an empty KB match isn't worth a footer).
  const renderCitations = (message) => {
    const log = message.retrievedChunkIds;
    if (!Array.isArray(log) || log.length === 0) return null;
    const titles = log
      .flatMap((call) => (Array.isArray(call.output) ? call.output : []))
      .map((hit) => hit.title || (hit.content || "").slice(0, 20))
      .filter(Boolean);
    if (titles.length === 0) return null;
    return (
      <div className="copilot-citations">
        参考资料：{[...new Set(titles)].join("、")}
      </div>
    );
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
        title={isOpen ? "关闭欣欣助手" : "打开欣欣助手"}
      >
        <i className={`fas fa-${isOpen ? "times" : "comment-dots"}`}></i>
      </button>

      {isOpen && (
        <div className="copilot-panel" ref={panelRef} style={{ width: panelSize.width, height: panelSize.height }}>
          <div className="copilot-resize-handle" onMouseDown={onResizeMouseDown} title="拖动调整大小"></div>
          <div className="copilot-header">
            <span>欣欣助手</span>
            <div>
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
                {messages.map((m, i) => (
                  <div key={m.id || `pending-${i}`} className={`copilot-bubble copilot-bubble-${m.role}`}>
                    <div className="copilot-bubble-content">{m.content}</div>
                    {m.role === "assistant" && renderCitations(m)}
                  </div>
                ))}
                {isSending && (
                  <div className="copilot-bubble copilot-bubble-assistant copilot-bubble-thinking">
                    <div className="copilot-bubble-content">思考中...</div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {error && <div className="alert alert-info py-1 px-2 copilot-error">{error}</div>}

              <form className="copilot-input-row" onSubmit={send}>
                <input
                  type="text"
                  className="form-control"
                  placeholder="输入问题..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={isSending}
                />
                <button type="submit" className="btn btn-primary" disabled={isSending || !input.trim()}>
                  {isSending ? "..." : "发送"}
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default CopilotPanel;
