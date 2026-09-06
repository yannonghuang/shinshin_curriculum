import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import ChatDataService from "../services/chat.service";
import AuthService from "../services/auth.service";
import "../curriculum.css";

// Floating slide-in co-pilot -- mounted once in App.js for any logged-in
// user. "Session" is just "this user's most recent conversation row" (see
// chat.controller.js) -- no client-side conversation-id caching, the panel
// always asks the backend for "current" on open.
//
// pageContext is derived from the current route (useLocation), not passed as
// a prop from whichever page is active -- this component is mounted once,
// globally, outside any per-page tree, so reading the URL here is simpler
// than plumbing a prop through every page that might want to set it. Only
// /plans/:id is recognized today; extend the regex if other pages should
// contribute context later.
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

  const loadCurrent = async () => {
    try {
      const resp = await ChatDataService.getCurrent();
      setMessages(resp.data.messages || []);
      setIsLoaded(true);
    } catch (e) {
      console.log(e);
      setError("加载对话失败。");
    }
  };

  useEffect(() => {
    if (isOpen && !isLoaded) {
      loadCurrent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  if (!isLoggedIn) return null;

  const pageContext = (() => {
    const match = PLAN_PAGE_RE.exec(location.pathname);
    return match ? { planId: Number(match[1]) } : undefined;
  })();

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
      const resp = await ChatDataService.sendMessage(content, pageContext);
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
      await ChatDataService.startNew();
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
            <button type="button" className="btn btn-sm btn-link copilot-new-btn" onClick={startNew}>
              新对话
            </button>
          </div>

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
        </div>
      )}
    </div>
  );
};

export default CopilotPanel;
