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
