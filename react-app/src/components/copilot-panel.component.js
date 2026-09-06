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

const CopilotPanel = () => {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef(null);

  const isLoggedIn = !!AuthService.getCurrentUser();

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
        title={isOpen ? "关闭助手" : "打开助手"}
      >
        <i className={`fas fa-${isOpen ? "times" : "comment-dots"}`}></i>
      </button>

      {isOpen && (
        <div className="copilot-panel">
          <div className="copilot-header">
            <span>助手</span>
            <button type="button" className="btn btn-sm btn-link copilot-new-btn" onClick={startNew}>
              新对话
            </button>
          </div>

          <div className="copilot-messages">
            {!isLoaded && <div className="pl-empty">加载中...</div>}
            {isLoaded && messages.length === 0 && <div className="pl-empty">有什么可以帮您的？</div>}
            {messages.map((m, i) => (
              <div key={m.id || `pending-${i}`} className={`copilot-bubble copilot-bubble-${m.role}`}>
                <div className="copilot-bubble-content">{m.content}</div>
                {m.role === "assistant" && renderCitations(m)}
              </div>
            ))}
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
