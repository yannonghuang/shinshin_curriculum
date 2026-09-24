import { skipNextUnsavedWarning } from "../utils/unsavedChangesGuard";
import { stashUnsavedWork } from "../utils/sessionExpiryGuard";

// Shared by token-renewal-interceptor.js (reactive: a request revealed the
// session is dead) and session-watchdog.js (proactive: no request needed to
// notice, a timer caught it) -- same end state either way. Full page reload
// (not client-side routing) is deliberate, so no stale in-memory React
// state from the now-invalid session lingers. Guards against redirect-
// looping if already on /login.
//
// skipNextUnsavedWarning: a route component with unsaved edits (e.g.
// PlanDetail) guards unload with its own beforeunload listener -- left
// alone, that listener blocks (or, in a background tab, silently cancels)
// this redirect, stranding the page with the user already cleared from
// localStorage: confirmed as a real bug, a teacher's plan editor timed out
// into a read-only view (isOwner false, since getCurrentUser() is now null)
// instead of landing on /login. Those edits can't be saved without a live
// session anyway, so there's nothing for that prompt to protect here --
// they're stashed as a local draft instead (see utils/sessionExpiryGuard.js),
// before "user" is removed, since a draft is keyed by that user's id.
const clearSessionAndRedirectToLogin = () => {
  stashUnsavedWork();
  localStorage.removeItem("user");
  if (window.location.pathname !== "/login") {
    skipNextUnsavedWarning();
    window.location.href = "/login";
  }
};

export default clearSessionAndRedirectToLogin;
