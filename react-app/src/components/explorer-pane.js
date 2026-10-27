import React, { useEffect, useRef } from "react";
import { useHistory, useLocation } from "react-router-dom";

// Phone layout for the .pl-explorer pages (全部乡土课程's tree, a plan's
// 计划/实施 tree, 学习资源库): side by side, the tree and the content fit;
// stacked on a narrow screen, the content landed below a tree that can run
// to dozens of schools, so picking something showed nothing anywhere near
// where the user tapped. Below NARROW_QUERY the page shows one pane at a
// time instead -- the tree, or the picked content under a bar that leads
// back to the tree -- the usual phone drill-down. Wide screens are untouched.
//
// Which pane is open lives in the URL (?pane=content), pushed as its own
// history entry, so the phone's back button returns to the tree, and coming
// back to the page (a plan's 返回 is a goBack()) reopens the content the
// user left from. Which pane is *hidden* is pure CSS on the .pl-explorer
// container (see curriculum.css), so nothing unmounts -- a plan's unsaved
// form stays put while the teacher looks at the tree.
const NARROW_QUERY = "(max-width: 768px)";
// What counts as "picked something to look at": the tree's leaves, plus any
// row a page marks as one (学习资源库's 使用指南 topic is a folder-styled
// row that opens content directly). Folder headers only expand/collapse --
// even the ones that also select (a plan's 计划 / 课时N) keep the tree up.
const LEAF_SELECTOR = ".pl-explorer-leaf, [data-explorer-leaf]";
const PANE_PARAM = "pane";

const isNarrow = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(NARROW_QUERY).matches;

const searchWith = (search, pane) => {
  const params = new URLSearchParams(search || "");
  if (pane) params.set(PANE_PARAM, pane);
  else params.delete(PANE_PARAM);
  return params.toString();
};

// startOpen: the page was linked straight to one item (a plan's
// ?view=reviews from 数据看板) -- open on it rather than on the tree. A
// replace, not a push: there's no tree entry of this page to go back to.
export const useExplorerPane = ({ startOpen = false } = {}) => {
  const history = useHistory();
  const location = useLocation();
  const contentOpen = new URLSearchParams(location.search || "").get(PANE_PARAM) === "content";
  // Set on the entry openContent pushes, so going back to the tree can pop
  // it (rather than stacking a second tree entry on top).
  const pushedHere = !!(location.state && location.state.explorerPane);

  useEffect(() => {
    if (startOpen && !contentOpen && isNarrow()) {
      history.replace({ pathname: location.pathname, search: searchWith(location.search, "content"), state: location.state });
    }
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back on the tree: bring the item the user came from into view, rather
  // than leaving them at the top of a long list.
  const wasOpen = useRef(contentOpen);
  useEffect(() => {
    if (wasOpen.current && !contentOpen && isNarrow()) {
      window.requestAnimationFrame(() => {
        const active = document.querySelector(".pl-explorer-nav .is-active");
        if (active) active.scrollIntoView({ block: "center" });
      });
    }
    wasOpen.current = contentOpen;
  }, [contentOpen]);

  // The tree's onClick (delegated, so no leaf needs wiring of its own).
  const onNavClick = (e) => {
    if (contentOpen || !isNarrow() || !e.target.closest(LEAF_SELECTOR)) return;
    // A page that syncs its selection into the URL does so in an effect,
    // after this -- it must start from history.location (this entry) and
    // keep its state, see plans-hierarchy.component.js.
    const current = history.location;
    history.push({ pathname: current.pathname, search: searchWith(current.search, "content"), state: { explorerPane: true } });
    window.scrollTo(0, 0);
  };

  const openNav = () => {
    if (pushedHere) history.goBack();
    else history.replace({ pathname: location.pathname, search: searchWith(location.search, null) });
  };

  return {
    // For the .pl-explorer container.
    className: contentOpen ? "is-pane-content" : "is-pane-nav",
    onNavClick,
    openNav,
    // How many entries a "leave this page" goBack() must pop -- the pushed
    // ?pane=content entry is still this page.
    backSteps: pushedHere ? 2 : 1,
  };
};

// Atop the content on a phone (hidden by CSS on wide screens): what's being
// shown, and the way back to the tree.
export const ExplorerPaneBar = ({ label, onBack }) => (
  <button type="button" className="pl-explorer-pane-bar" onClick={onBack}>
    <i className="fas fa-chevron-left mr-2"></i>
    <span className="pl-explorer-pane-bar-label">{label}</span>
    <span className="pl-explorer-pane-bar-switch">
      <i className="fas fa-list mr-1"></i>目录
    </span>
  </button>
);

// For a page whose own route guard (<Prompt>) shouldn't fire on switching
// panes: the move stays on the same pathname.
export const isPaneSwitch = (fromPathname, toLocation) => !!toLocation && toLocation.pathname === fromPathname;
