import React, { useEffect, useRef, useState } from "react";

import AiLetterIcon from "./ai-letter-icon.component";
import "../curriculum.css";

// "Context-aware" 欣欣小助手: a small 小助手 trigger that shows up while the
// pointer is over (or the caret is in) a field or section of the plan page,
// and opens a menu of questions about *that* part. Picking one opens the
// co-pilot panel with the part attached as the question's focus (see
// copilot-panel.component.js's "copilot:open" listener and backend
// copilotFocus.js) -- the teacher no longer has to say which section they
// mean or paste its text in.
//
// target: { kind, labelPath, fieldKey?, sectionKey?, lessonIndex?, getDraft }
//   -- getDraft() returns what the part holds on screen right now (possibly
//   unsaved), read at send time, so follow-up questions see later edits too.
// presets: from askAiPresets below, chosen by the user's relationship to the
//   plan (author / reviewing expert / admin / browsing teacher).

// How long the menu stays open after the pointer leaves it -- enough to
// cross the gap between trigger and menu without it snapping shut.
const CLOSE_DELAY_MS = 250;

// Prompts read naturally for one field ("这一栏") or a whole section/lesson
// ("这一部分"); `name` is the part's own label (last labelPath entry).
const PRESETS = {
  improve: {
    label: "帮我完善",
    icon: "magic",
    prompt: (name, unit) => `请帮我完善「${name}」${unit}：先指出目前内容的主要不足，再给出可以直接替换使用的修改稿。`,
  },
  howTo: {
    label: "这里该怎么写",
    icon: "question-circle",
    prompt: (name, unit) => `「${name}」${unit}应该写什么？请结合本课程的主题、年级和地区说明要点，并给一个简短示例。`,
  },
  ideas: {
    label: "找思路和资料",
    icon: "lightbulb",
    prompt: (name, unit) => `请为「${name}」${unit}提供一些结合本地乡土资源的思路，并推荐相关参考资料。`,
  },
  consistency: {
    label: "检查前后一致",
    icon: "check-double",
    prompt: (name, unit) => `请检查「${name}」${unit}与本课程设计其他部分（尤其是学习目标）是否一致，列出不一致或缺失之处。`,
  },
  explain: {
    label: "解读这里",
    icon: "book-open",
    prompt: (name, unit) => `请简要解读「${name}」${unit}的内容和设计意图。`,
  },
  borrow: {
    label: "有什么可借鉴",
    icon: "hands-helping",
    prompt: (name, unit) => `「${name}」${unit}有哪些值得我在自己的课程设计中借鉴的做法？`,
  },
};

// 基本信息's own entries -- advice runs between its parts (the school's
// locality -> 乡土主题/标题, a 标题 -> its 乡土主题, a 乡土主题 -> 标题;
// see backend copilotFocus.js#describeBasicContext), not writing help for
// one free-text field.
const BASIC_PRESETS = {
  suggestTitles: {
    label: "推荐标题",
    icon: "lightbulb",
    prompt: () => "请结合我校所在地的乡土资源，以及已选的乡土主题和年级，推荐 3–5 个可直接使用的课程标题，每个附一句理由。",
  },
  suggestThemes: {
    label: "推荐乡土主题",
    icon: "map-marked-alt",
    prompt: () => "请根据我校所在地区以及已填写的标题，推荐最合适的乡土主题，并说明理由。",
  },
  checkMatch: {
    label: "检查信息匹配",
    icon: "check-double",
    prompt: () => "请检查基本信息各项（标题、乡土主题、年级、学生人数、预计课时）是否相互匹配、是否立足我校当地，列出问题并给出调整建议。",
  },
};

// `keys` picks which 基本信息 entries a given menu shows (the whole section
// vs. its 标题 / 乡土主题 field); a non-author gets the usual read-only ones.
export const basicInfoPresets = ({ isAuthor, isExpert, isAdmin }, keys = Object.keys(BASIC_PRESETS)) =>
  isAuthor ? keys.map((key) => ({ key, ...BASIC_PRESETS[key] })) : askAiPresets({ isAuthor, isExpert, isAdmin });

// The plan's author gets writing help; anyone else is reading someone
// else's plan -- an expert/admin just gets it explained (no ready-made
// review or consistency check), a teacher also what to learn from it.
export const askAiPresets = ({ isAuthor, isExpert, isAdmin }) => {
  const keys = isAuthor ? ["improve", "howTo", "ideas", "consistency"] : isExpert || isAdmin ? ["explain"] : ["explain", "borrow"];
  return keys.map((key) => ({ key, ...PRESETS[key] }));
};

const AskAiMenu = ({ target, presets, unit = "这一栏" }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const closeTimer = useRef(null);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => cancelClose, []);

  // Click outside / Escape closes it, like any menu.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = target.labelPath[target.labelPath.length - 1];

  // prompt === undefined: 自由提问 -- the panel opens with the focus
  // attached and the caret in the input, nothing sent yet.
  const ask = (prompt) => {
    setOpen(false);
    const { getDraft, ...focus } = target;
    window.dispatchEvent(new CustomEvent("copilot:open", { detail: { focus, getDraft, prompt } }));
  };

  return (
    <span className={`ai-ask${open ? " is-open" : ""}`} ref={rootRef} onMouseLeave={scheduleClose} onMouseEnter={cancelClose}>
      <button
        type="button"
        className="ai-ask-trigger"
        // No tooltip while open -- it would cover the menu's own title.
        title={open ? undefined : `就「${name}」问欣欣小助手`}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onClick={() => setOpen((v) => !v)}
      >
        <AiLetterIcon size={16} />
        <span>小助手</span>
      </button>
      {open && (
        <div className="ai-ask-menu" role="menu">
          <div className="ai-ask-menu-title">就「{name}」{unit}：</div>
          {presets.map((p) => (
            <button key={p.key} type="button" role="menuitem" className="ai-ask-item" onClick={() => ask(p.prompt(name, unit))}>
              {/* key'd span around the <i> -- FontAwesome's JS swaps it for an <svg> (see copilot-panel's chips) */}
              <span className="ai-ask-item-icon">
                <i className={`fas fa-${p.icon}`}></i>
              </span>
              {p.label}
            </button>
          ))}
          <button type="button" role="menuitem" className="ai-ask-item ai-ask-item-free" onClick={() => ask(undefined)}>
            <span className="ai-ask-item-icon">
              <i className="fas fa-pen"></i>
            </span>
            自由提问…
          </button>
        </div>
      )}
    </span>
  );
};

export default AskAiMenu;
