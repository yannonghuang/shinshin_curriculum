// Lets a route component with unsaved edits (e.g. PlanDetail) get them
// saved when the session is about to time out, instead of losing them to
// the forced redirect to /login (see services/clear-session.js). Two layers:
//  - save(): a real server save, run by session-watchdog.js shortly
//    *before* expiry while the token is still valid.
//  - stash(): a synchronous localStorage draft, written both right before
//    that save attempt and by clear-session.js on every forced logout --
//    the fallback for when the pre-expiry window got missed entirely
//    (laptop asleep, background tab's timers throttled) and the token is
//    already dead, so the server would just 401. The component restores it
//    the next time the same user opens the same page.
// A plain module-level Set rather than React context: the watchdog and
// clear-session.js live outside the React tree.
const handlers = new Set();

// handler: { hasUnsaved(): bool, stash(): void, save(): Promise }
export const registerSessionExpiryHandler = (handler) => {
  handlers.add(handler);
  return () => handlers.delete(handler);
};

export const hasUnsavedWork = () => [...handlers].some((h) => h.hasUnsaved());

export const stashUnsavedWork = () => {
  handlers.forEach((h) => {
    try {
      if (h.hasUnsaved()) h.stash();
    } catch (e) {
      console.log(e);
    }
  });
};

export const saveUnsavedWork = () =>
  Promise.allSettled([...handlers].filter((h) => h.hasUnsaved()).map((h) => h.save()));

// The stash() storage, shared by every handler (plan edits in PlanDetail,
// an expert's review form in ReviewList). A handler's key must include the
// user's id, so a draft never leaks into someone else's session on a shared
// computer.
export const writeLocalDraft = (key, parts) => {
  try {
    localStorage.setItem(key, JSON.stringify({ ...parts, savedAt: Date.now() }));
  } catch (e) {
    console.log(e);
  }
};

// Reads and removes the draft in one go.
export const takeLocalDraft = (key) => {
  try {
    const raw = localStorage.getItem(key);
    localStorage.removeItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};

// A restored draft is dropped if the server copy changed after it was
// stashed -- with this much slack, since savedAt is the browser's clock and
// updatedAt the server's, and a partially-successful auto-save bumps
// updatedAt just before the draft of its failed remainder is written.
export const DRAFT_CLOCK_SLACK_MS = 5 * 60 * 1000;

export const isDraftStale = (draft, serverUpdatedAt) =>
  !!serverUpdatedAt && new Date(serverUpdatedAt).getTime() > draft.savedAt + DRAFT_CLOCK_SLACK_MS;
