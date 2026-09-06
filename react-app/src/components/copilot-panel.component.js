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

// Default size/placement, and the margin from the viewport edge -- used only
// to compute an initial top/left once per open (see panelPos below).
const PANEL_DEFAULT_WIDTH = 360;
const PANEL_DEFAULT_HEIGHT = 520;
const PANEL_MARGIN = 20;
const TOGGLE_CLEARANCE = 84; // leaves room above the floating toggle button

const CopilotPanel = () => {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef(null);
  // Anchored via top/left (computed once, on first open), not right/bottom --
  // CSS `resize` only ever grows/shrinks a box from its bottom-right corner
  // while its top/left stay fixed. Anchoring via right/bottom instead would
  // mean growing the box moves its *top-left* corner outward while the
  // bottom-right corner (where the resize grip visually sits, and where a
  // user's cursor actually is while dragging) never moves on screen at all --
  // confirmed via a real drag simulation: the box's right/bottom screen
  // position was bit-for-bit identical before and after resizing either
  // direction. Top/left anchoring is what makes "drag the corner to make it
  // bigger" track the cursor the way every other resizable box does.
  const [panelPos, setPanelPos] = useState(null);

  useEffect(() => {
    if (isOpen && !panelPos) {
      setPanelPos({
        left: Math.max(8, window.innerWidth - PANEL_MARGIN - PANEL_DEFAULT_WIDTH),
        top: Math.max(8, window.innerHeight - TOGGLE_CLEARANCE - PANEL_DEFAULT_HEIGHT),
      });
    }
  }, [isOpen, panelPos]);

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
        <div className="copilot-panel" style={panelPos ? { left: panelPos.left, top: panelPos.top } : undefined}>
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
